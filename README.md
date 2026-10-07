# ShelbyGallery — Live Shelbynet Integration

🟢 **[Live Demo → shelby-gallery-live.vercel.app](https://shelby-gallery-live.vercel.app)**

> Decentralized media platform with **real** `@shelby-protocol/sdk` integration: blob storage, retrieval, AND a fully working micropayment channel lifecycle on shelbynet.

## Real SDK integration

### Storage
- `shelbyClient.fundAccountWithAPT()` / `fundAccountWithShelbyUSD()` — faucet funding
- `shelbyClient.upload()` — real blob upload: clay erasure coding → storage provider dispersal → Aptos commitment
- `shelbyClient.download()` — retrieve blobs back from the network (the **⇊ verify** button)

### Micropayments (full lifecycle)
- `initializePaymentChannels()` — viewer registers on the micropayment contract (on-chain)
- `createChannel()` — viewer→creator channel with ShelbyUSD deposit locked (on-chain)
- `createMicropayment()` — **off-chain signed** cumulative payment per view — instant, no gas
- `receiverWithdraw()` — creator settles accumulated earnings on-chain with the last signed micropayment
- `getChannelInfo()` — live channel state (id, balance, sequence number)

This demonstrates the core economic loop Shelby was designed for: content stored on the network, paid reads via payment channels, creators earning directly.

## Run locally

```bash
npm install
npm run dev
```

## Demo flow

1. App generates a viewer account + a creator account on load
2. **⛽ faucet** — funds viewer with APT + ShelbyUSD via shelbynet faucet
3. **⚡ Open Real Channel** — on-chain: initialize + createChannel with ShelbyUSD deposit
4. Upload media — written to the real Shelby network
5. Click any item → **Pay & Watch** — signs a real off-chain micropayment (watch the sequence number and cumulative units climb in the channel panel)
6. **💰 Creator Withdraw** — creator submits the last micropayment on-chain and receives the funds
7. **⇊ verify** on any stored blob — downloads it back from storage providers
8. SDK log shows every real network call

## Stack

- Vite + React + TypeScript
- `@shelby-protocol/sdk` v0.9.2 (browser build)
- `@aptos-labs/ts-sdk`
- Network: `shelbynet`

Built for the Shelby production access application — evolved from the original ShelbyGallery early-access prototype.
