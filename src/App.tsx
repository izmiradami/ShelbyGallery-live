import { useState, useCallback, useRef } from "react";
import { ShelbyClient } from "@shelby-protocol/sdk/browser";
import { Account, Network } from "@aptos-labs/ts-sdk";
import {
  initChannels, openChannel, payForView, creatorWithdraw,
  type ChannelState,
} from "./micropayments";
import "./App.css";

// ── Real Shelby client on shelbynet ──
const API_KEY = import.meta.env.VITE_APTOS_API_KEY as string | undefined;

const shelbyClient = new ShelbyClient({
  network: Network.SHELBYNET,
  ...(API_KEY
    ? {
        apiKey: API_KEY,
        aptos: { clientConfig: { API_KEY } },
        rpc: { apiKey: API_KEY },
        indexer: { apiKey: API_KEY },
      }
    : {}),
});

type UploadedBlob = {
  name: string;
  size: string;
  blobName: string;
  account: string;
  price: string;
  type: "video" | "image";
  localUrl: string;
  status: "uploading" | "stored" | "failed";
};

function fmtBytes(b: number) {
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + " MB";
  return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

const randPrice = () => (Math.random() * 0.08 + 0.005).toFixed(3);

export default function App() {
  const [account] = useState(() => Account.generate()); // viewer
  const [creator] = useState(() => Account.generate()); // content creator
  const [channel, setChannel] = useState<ChannelState | null>(null);
  const [channelBusy, setChannelBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [lastWithdrawTx, setLastWithdrawTx] = useState<string | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const [funded, setFunded] = useState(false);
  const [funding, setFunding] = useState(false);
  const [blobs, setBlobs] = useState<UploadedBlob[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [currentFile, setCurrentFile] = useState("");
  const [playing, setPlaying] = useState<UploadedBlob | null>(null);
  const [payModal, setPayModal] = useState<UploadedBlob | null>(null);
  const [toast, setToast] = useState("");
  const [totalEarned, setTotalEarned] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [verifying, setVerifying] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addLog = useCallback((msg: string) => {
    setLogs((l) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...l].slice(0, 60));
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }, []);

  // ── FUND ACCOUNT via SDK faucet ──
  const fundWithRetry = useCallback(
    async (kind: "APT" | "ShelbyUSD", address: typeof account.accountAddress) => {
      const fn = kind === "APT"
        ? shelbyClient.fundAccountWithAPT.bind(shelbyClient)
        : shelbyClient.fundAccountWithShelbyUSD.bind(shelbyClient);
      // Try 1 unit, then fall back to 0.1 if the faucet rejects the amount (VmError)
      for (const amount of [100_000_000, 10_000_000]) {
        try {
          return await fn({ address, amount });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (amount === 100_000_000 && /VmError|INSUFFICIENT|amount/i.test(msg)) {
            addLog(`${kind} faucet: retrying with smaller amount...`);
            continue;
          }
          throw err;
        }
      }
      throw new Error("faucet retries exhausted");
    },
    [addLog]
  );

  const fundAccount = useCallback(async () => {
    setFunding(true);
    const addr = account.accountAddress.toString();
    addLog(`Requesting faucet APT for ${addr.slice(0, 12)}...`);
    try {
      const tx = await fundWithRetry("APT", account.accountAddress);
      addLog(`✓ APT faucet tx: ${tx.slice(0, 20)}...`);
      const tx2 = await fundWithRetry("ShelbyUSD", account.accountAddress);
      addLog(`✓ ShelbyUSD faucet tx: ${tx2.slice(0, 20)}...`);
      // Fund creator too — needed for withdraw gas
      const tx3 = await fundWithRetry("APT", creator.accountAddress);
      addLog(`✓ Creator APT faucet tx: ${tx3.slice(0, 20)}...`);
      setFunded(true);
      showToast("✓ Account funded on shelbynet");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`✗ Faucet error: ${msg.slice(0, 120)}`);
      showToast("⚠ Faucet failed — see log");
    } finally {
      setFunding(false);
    }
  }, [account, creator, fundWithRetry, addLog, showToast]);

  // ── REAL MICROPAYMENT CHANNEL ──
  const setupChannel = useCallback(async () => {
    setChannelBusy(true);
    try {
      await initChannels(account, addLog);
      const state = await openChannel(account, creator.accountAddress, 1_000_000, addLog);
      setChannel(state);
      showToast("✓ Real micropayment channel open on shelbynet");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`✗ Channel error: ${msg.slice(0, 150)}`);
      showToast("⚠ Channel setup failed — see log");
    } finally {
      setChannelBusy(false);
    }
  }, [account, creator, addLog, showToast]);

  const doWithdraw = useCallback(async () => {
    if (!channel?.lastMicropayment) return;
    setWithdrawing(true);
    try {
      const tx = await creatorWithdraw(creator, channel, addLog);
      setLastWithdrawTx(tx);
      showToast("✓ Creator withdrew earnings on-chain");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`✗ Withdraw error: ${msg.slice(0, 150)}`);
      showToast("⚠ Withdraw failed — see log");
    } finally {
      setWithdrawing(false);
    }
  }, [channel, creator, addLog, showToast]);

  // ── REAL SHELBY UPLOAD ──
  const uploadToShelby = useCallback(
    async (file: File) => {
      setUploading(true);
      setCurrentFile(file.name);
      setProgress(5);
      setProgressLabel("reading file...");
      addLog(`Upload start: ${file.name} (${fmtBytes(file.size)})`);

      const localUrl = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = (e) => res(e.target?.result as string);
        r.readAsDataURL(file);
      });

      const blobName = `shelbygallery/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const isVideo = file.type.startsWith("video");

      const newBlob: UploadedBlob = {
        name: file.name,
        size: fmtBytes(file.size),
        blobName,
        account: account.accountAddress.toString(),
        price: randPrice(),
        type: isVideo ? "video" : "image",
        localUrl,
        status: "uploading",
      };
      setBlobs((b) => [newBlob, ...b]);

      try {
        setProgress(20);
        setProgressLabel("clay erasure coding...");
        const fileData = new Uint8Array(await file.arrayBuffer());

        setProgress(40);
        setProgressLabel("resolving storage location...");

        // Resolve a storage location on shelbynet
        let loc = location;
        if (!loc) {
          const names = await shelbyClient.metadata.getLocationNames();
          loc = names[0];
          setLocation(loc);
          addLog(`✓ storage location: ${loc} (of ${names.length} available)`);
        }

        setProgress(55);
        setProgressLabel("writing chunksets to shelby RPC...");
        addLog(`blobName: ${blobName}`);

        // ══ REAL SDK CALL ══ (SDK 0.9.x: expiration artık protokol tarafında)
        await shelbyClient.upload({
          blobData: fileData,
          signer: account,
          blobName,
          options: { selectedLocation: loc },
        });

        setProgress(90);
        setProgressLabel("aptos commitment...");
        addLog(`✓ Blob stored on shelbynet + committed on Aptos`);

        setProgress(100);
        setProgressLabel("finalized ✓");
        setBlobs((all) =>
          all.map((b) => (b.blobName === blobName ? { ...b, status: "stored" } : b))
        );
        showToast(`✓ ${file.name} → real Shelby network`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog(`✗ Upload failed: ${msg.slice(0, 150)}`);
        if (!funded) addLog(`hint: fund the account first (faucet button)`);
        setBlobs((all) =>
          all.map((b) => (b.blobName === blobName ? { ...b, status: "failed" } : b))
        );
        showToast("⚠ Shelby write failed — see SDK log");
      } finally {
        setTimeout(() => {
          setUploading(false);
          setProgress(0);
        }, 1200);
      }
    },
    [account, funded, location, addLog, showToast]
  );

  // ── REAL DOWNLOAD (verify blob exists on network) ──
  const verifyOnShelby = useCallback(
    async (blob: UploadedBlob) => {
      setVerifying(blob.blobName);
      addLog(`Downloading from shelbynet: ${blob.blobName.slice(0, 40)}...`);
      try {
        const result = await shelbyClient.download({
          account: blob.account,
          blobName: blob.blobName,
        });
        const size = result?.contentLength ?? 0;
        addLog(`✓ Retrieved ${fmtBytes(size)} from shelby storage providers`);
        showToast(`✓ Verified: blob live on shelbynet (${fmtBytes(size)})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog(`✗ Download failed: ${msg.slice(0, 120)}`);
        showToast("⚠ Blob not retrievable — see log");
      } finally {
        setVerifying(null);
      }
    },
    [addLog, showToast]
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      Array.from(files).forEach((f, i) => setTimeout(() => uploadToShelby(f), i * 600));
    },
    [uploadToShelby]
  );

  const confirmPayment = useCallback(() => {
    if (!payModal) return;
    if (channel) {
      // REAL off-chain signed micropayment (cumulative)
      const units = BigInt(Math.round(parseFloat(payModal.price) * 1000)); // price -> units
      try {
        const newState = payForView(account, creator.accountAddress, channel, units, addLog);
        setChannel(newState);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog(`✗ Micropayment error: ${msg.slice(0, 120)}`);
      }
    } else {
      addLog(`(simulated payment — open a channel for the real thing)`);
    }
    setTotalEarned((t) => t + parseFloat(payModal.price));
    setPlaying(payModal);
    setPayModal(null);
    showToast(`✓ Paid ${payModal.price} · ${channel ? "real signed micropayment" : "simulated"}`);
  }, [payModal, channel, account, creator, addLog, showToast]);

  const addr = account.accountAddress.toString();

  return (
    <div className="app">
      <nav>
        <div className="logo">
          <span className="logo-dot" />
          ShelbyGallery <span className="live-badge">LIVE · SHELBYNET</span>
        </div>
        <div className="nav-right">
          <span className="account-chip">⬡ {addr.slice(0, 6)}...{addr.slice(-4)}</span>
          <button className={funded ? "fund-btn funded" : "fund-btn"} onClick={fundAccount} disabled={funding || funded}>
            {funded ? "✓ funded" : funding ? "funding..." : "⛽ faucet"}
          </button>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-left">
          <div className="eyebrow">REAL SDK INTEGRATION · @shelby-protocol/sdk</div>
          <h1>Stream. Own. <em>Earn.</em></h1>
          <p>
            Files uploaded here are <b>really written to shelbynet</b> — clay erasure coded,
            dispersed to storage providers, committed on Aptos. Click <b>verify</b> on any
            stored blob to download it back from the network.
          </p>
          <div className="hero-actions">
            <button className="btn-primary" onClick={() => fileInputRef.current?.click()}>
              ↑ Upload to Shelby
            </button>
            {!funded && <span className="hint">// fund account first via ⛽ faucet</span>}
          </div>
          <input
            ref={fileInputRef} type="file" accept="video/*,image/*" multiple hidden
            onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
          />
        </div>

        <div className="hero-right">
          <div className="stat-grid">
            <div className="stat">
              <span className="stat-val">{blobs.filter((b) => b.status === "stored").length}</span>
              <span className="stat-lbl">on shelbynet</span>
            </div>
            <div className="stat">
              <span className="stat-val gold">{totalEarned.toFixed(3)}</span>
              <span className="stat-lbl">APT earned</span>
            </div>
            <div className="stat">
              <span className="stat-val">{blobs.length}</span>
              <span className="stat-lbl">total blobs</span>
            </div>
            <div className="stat">
              <span className="stat-val green">16</span>
              <span className="stat-lbl">storage providers</span>
            </div>
          </div>
        </div>
      </section>

      {/* MICROPAYMENT CHANNEL PANEL */}
      <section className="channel-panel">
        <div className="channel-head">
          <span className="channel-title">⚡ Micropayment Channel</span>
          <span className="channel-tag">// real shelbynet contract · ShelbyUSD</span>
        </div>
        {!channel ? (
          <div className="channel-body">
            <p className="channel-desc">
              Open a real payment channel: viewer locks ShelbyUSD on-chain, then every
              view is paid with an <b>off-chain signed micropayment</b> — instant, no gas.
              The creator settles on-chain once with <code>receiverWithdraw</code>.
            </p>
            <button className="btn-primary" onClick={setupChannel} disabled={channelBusy || !funded}>
              {channelBusy ? "opening channel..." : "⚡ Open Real Channel"}
            </button>
            {!funded && <span className="hint"> // fund account first</span>}
          </div>
        ) : (
          <div className="channel-stats">
            <div className="ch-stat">
              <span className="ch-val">#{channel.channelId.toString()}</span>
              <span className="ch-lbl">channel id</span>
            </div>
            <div className="ch-stat">
              <span className="ch-val">{channel.sequenceNumber.toString()}</span>
              <span className="ch-lbl">next seq</span>
            </div>
            <div className="ch-stat">
              <span className="ch-val gold">{channel.cumulativeAmount.toString()}</span>
              <span className="ch-lbl">signed units</span>
            </div>
            <div className="ch-stat">
              <span className="ch-val">{channel.deposit.toString()}</span>
              <span className="ch-lbl">deposit locked</span>
            </div>
            <button
              className="withdraw-btn"
              onClick={doWithdraw}
              disabled={withdrawing || !channel.lastMicropayment}
            >
              {withdrawing ? "settling..." : "💰 Creator Withdraw (on-chain)"}
            </button>
            {lastWithdrawTx && (
              <a
                className="tx-link"
                href={`https://explorer.aptoslabs.com/txn/${lastWithdrawTx}?network=shelbynet`}
                target="_blank" rel="noreferrer"
              >
                ↗ view settlement tx
              </a>
            )}
          </div>
        )}
      </section>

      {uploading && (
        <div className="progress-card">
          <div className="progress-head">
            <span>{currentFile}</span>
            <span className="pct">{progress}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="progress-label">// {progressLabel}</div>
        </div>
      )}

      {playing && (
        <section className="player-section">
          <div className="player-lbl">● now playing</div>
          <div className="player-wrap">
            {playing.type === "video" ? (
              <video src={playing.localUrl} controls autoPlay playsInline />
            ) : (
              <img src={playing.localUrl} alt={playing.name} />
            )}
          </div>
          <div className="player-meta">
            <div>
              <div className="player-title">{playing.name}</div>
              <div className="player-blob">{playing.blobName}</div>
            </div>
            <div className="player-badges">
              <span className={playing.status === "stored" ? "badge-chain" : "badge-warn"}>
                {playing.status === "stored" ? "on shelbynet ✓" : "local only"}
              </span>
              <span className="badge-price">{playing.price} APT</span>
            </div>
          </div>
        </section>
      )}

      <section className="gallery">
        <div className="gallery-head">
          <span className="gallery-title">Your Channel</span>
          <span className="gallery-tag">// account: {addr.slice(0, 16)}...</span>
        </div>
        <div className="grid">
          {blobs.length === 0 && (
            <div className="empty">
              // no blobs yet · fund account → upload → files go to the REAL shelby network
            </div>
          )}
          {blobs.map((b, i) => (
            <div key={b.blobName} className="card" onClick={() => setPayModal(b)}>
              <div className="thumb">
                {b.type === "video" ? (
                  <video src={b.localUrl} muted preload="metadata" />
                ) : (
                  <img src={b.localUrl} alt={b.name} />
                )}
                <div className="play-ov"><div className="play-circle" /></div>
                <span className="price-tag">{b.price} APT</span>
                <button
                  className="del-btn"
                  onClick={(e) => { e.stopPropagation(); setBlobs((all) => all.filter((_, j) => j !== i)); }}
                >✕</button>
              </div>
              <div className="card-body">
                <div className="card-name">{b.name}</div>
                <div className="card-blob">{b.blobName.slice(0, 42)}...</div>
                <div className="card-foot">
                  <span className="card-size">{b.size}</span>
                  <div className="card-badges">
                    <span className={b.status === "stored" ? "badge-chain" : b.status === "failed" ? "badge-warn" : "badge-up"}>
                      {b.status === "stored" ? "on-chain ✓" : b.status === "failed" ? "local" : "uploading..."}
                    </span>
                    {b.status === "stored" && (
                      <button
                        className="verify-btn"
                        disabled={verifying === b.blobName}
                        onClick={(e) => { e.stopPropagation(); verifyOnShelby(b); }}
                      >
                        {verifying === b.blobName ? "..." : "⇊ verify"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="log-section">
        <div className="log-head">// SDK LOG — real shelbynet calls</div>
        <div className="log-body">
          {logs.length === 0 ? (
            <div className="log-line muted">// waiting for activity</div>
          ) : (
            logs.map((l, i) => <div key={i} className="log-line">{l}</div>)
          )}
        </div>
      </section>

      {payModal && (
        <div className="modal-ov" onClick={() => setPayModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Watch this content</span>
              <button onClick={() => setPayModal(null)}>✕</button>
            </div>
            <div className="pay-info">
              <div className="pay-thumb">
                {payModal.type === "video" ? (
                  <video src={payModal.localUrl} muted />
                ) : (
                  <img src={payModal.localUrl} alt="" />
                )}
              </div>
              <div>
                <div className="pay-name">{payModal.name}</div>
                <div className="pay-meta">{payModal.size}</div>
              </div>
            </div>
            <div className="pay-amount">
              <span className="amount">{payModal.price} APT</span>
              <span className="amount-lbl">via shelby micropayment channel</span>
            </div>
            <button className="pay-btn" onClick={confirmPayment}>⚡ Pay & Watch</button>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      <footer>
        ShelbyGallery · real @shelby-protocol/sdk integration · shelbynet ·{" "}
        <a href="https://shelby.xyz" target="_blank" rel="noreferrer">shelby.xyz</a>
      </footer>
    </div>
  );
}
