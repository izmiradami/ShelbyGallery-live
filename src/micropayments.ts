import {
  ShelbyMicropaymentChannelClient,
  SHELBYUSD_FA_METADATA_ADDRESS,
} from "@shelby-protocol/sdk/browser";
import { Account, AccountAddress, Network } from "@aptos-labs/ts-sdk";
import type { SenderBuiltMicropayment } from "@shelby-protocol/sdk/browser";

export const mpClient = new ShelbyMicropaymentChannelClient({
  network: Network.SHELBYNET,
});

export const SHELBYUSD = AccountAddress.fromString(SHELBYUSD_FA_METADATA_ADDRESS);

export type ChannelState = {
  channelId: bigint;
  sequenceNumber: bigint;
  cumulativeAmount: bigint; // in smallest units
  deposit: bigint;
  lastMicropayment?: SenderBuiltMicropayment;
};

/**
 * Full real flow:
 * 1. initializePaymentChannels (viewer, once)
 * 2. createChannel viewer -> creator with ShelbyUSD deposit
 * 3. per view: createMicropayment (off-chain signed, cumulative)
 * 4. creator: receiverWithdraw using last micropayment
 */
export async function initChannels(viewer: Account, log: (m: string) => void) {
  log("initializePaymentChannels: registering viewer on-chain...");
  const { transaction } = await mpClient.initializePaymentChannels({ sender: viewer });
  log(`✓ init tx: ${transaction.hash.slice(0, 24)}...`);
  await mpClient.aptos.waitForTransaction({ transactionHash: transaction.hash });
  log("✓ payment channels initialized");
}

export async function openChannel(
  viewer: Account,
  creator: AccountAddress,
  depositUnits: number,
  log: (m: string) => void
): Promise<ChannelState> {
  log(`createChannel: locking ${depositUnits} ShelbyUSD units...`);
  const { transaction } = await mpClient.createChannel({
    sender: viewer,
    receiver: creator,
    expirationMicros: BigInt(Date.now() * 1000 + 86400_000_000), // 1 day
    depositAmount: depositUnits,
    fungibleAssetAddress: SHELBYUSD,
  });
  log(`✓ channel tx: ${transaction.hash.slice(0, 24)}...`);
  await mpClient.aptos.waitForTransaction({ transactionHash: transaction.hash });

  const infos = await mpClient.getChannelInfo({
    sender: viewer.accountAddress,
    receiver: creator,
  });
  const info = infos[infos.length - 1];
  log(`✓ channel open · id=${info.paymentChannelId} · balance=${info.balance}`);
  return {
    channelId: BigInt(info.paymentChannelId),
    sequenceNumber: BigInt(info.nextWithdrawnSequenceNumber) > 0n ? BigInt(info.nextWithdrawnSequenceNumber) : 1n,
    cumulativeAmount: 0n,
    deposit: BigInt(info.balance),
  };
}

export function payForView(
  viewer: Account,
  creator: AccountAddress,
  state: ChannelState,
  amountUnits: bigint,
  log: (m: string) => void
): ChannelState {
  const newCumulative = state.cumulativeAmount + amountUnits;
  log(`createMicropayment: off-chain signed · seq=${state.sequenceNumber} · cumulative=${newCumulative}`);
  const mp = mpClient.createMicropayment({
    sender: viewer,
    receiver: creator,
    fungibleAssetAddress: SHELBYUSD,
    amount: newCumulative, // CUMULATIVE, not incremental
    paymentChannelId: state.channelId,
    sequenceNumber: state.sequenceNumber,
  });
  log(`✓ micropayment signed (no gas, no chain tx — this is the magic)`);
  return {
    ...state,
    sequenceNumber: state.sequenceNumber + 1n,
    cumulativeAmount: newCumulative,
    lastMicropayment: mp,
  };
}

export async function creatorWithdraw(
  creator: Account,
  state: ChannelState,
  log: (m: string) => void
) {
  if (!state.lastMicropayment) throw new Error("no micropayment to withdraw");
  log(`receiverWithdraw: creator claiming ${state.cumulativeAmount} units on-chain...`);
  const { transaction } = await mpClient.receiverWithdraw({
    receiver: creator,
    micropayment: state.lastMicropayment,
  });
  log(`✓ withdraw tx: ${transaction.hash.slice(0, 24)}...`);
  await mpClient.aptos.waitForTransaction({ transactionHash: transaction.hash });
  log(`✓ creator received ${state.cumulativeAmount} ShelbyUSD units`);
  return transaction.hash;
}
