import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  checkFreighterInstalled,
  connectFreighterWallet,
  buildPaymentEnvelope,
  submitEnvelopeWithFreighter,
  pathPaymentWithFreighter,
  changeTrustWithFreighter,
  readKitewellState,
  registerBuilderWithFreighter,
  submitFailureResult,
  signChallengeWithFreighter,
} from "./freighter";
import {
  createFailedSubmitLog,
  downloadFailedSubmitLog,
} from "./failedSubmitLog";
import { shortenAddress } from "./addressFormat";
import {
  fundWithFriendbot,
  getAccountBalances,
  getAccountDetails,
  getLiquidityPool,
  getTransactions,
  explorerAccountUrl,
  explorerTxUrl,
} from "./stellar";
import { poolShareRows } from "./poolShare";
import { validatePaymentAmount } from "./validatePaymentAmount";
import { fetchHealth, fetchNetworkInfo } from "./api";
import {
  NETWORKS,
  getActiveNetworkId,
  isFriendbotAvailable,
  setActiveNetwork,
} from "./network";
import { validateAssetCode } from "./validateAssetCode";
import { decodeTransactionEnvelope } from "./txInspector";
import { completeWebAuthChallenge } from "./sep10WebAuth";
import { loadIssuerCurrencyList } from "./issuerToml";
import { createPaymentStreamController } from "./paymentStream";
import {
  normaliseTxHash,
  txStatusPresentation,
  watchTransactionStatus,
} from "./txStatusWatch";
import { buildTransactionExplorerUrl } from "./explorerLink";
import "./App.css";

const TABS = [
  "Wallet",
  "Fund",
  "Assets",
  "Send",
  "Path",
  "History",
  "Inspect",
  "Issuer",
  "Web auth",
  "Lab",
];
const PATH_MODE_FIELDS = {
  strictSend: {
    amountLabel: "Amount to send",
    boundLabel: "Minimum received",
    boundHint: "Lowest amount of the destination asset you will accept.",
  },
  strictReceive: {
    amountLabel: "Amount to receive",
    boundLabel: "Maximum to send",
    boundHint: "Most of the send asset you are willing to spend.",
  },
};
const MEMO_FIELDS = {
  text: {
    maxLength: 28,
    placeholder: "Up to 28 UTF-8 bytes",
  },
  id: {
    maxLength: 20,
    pattern: "[0-9]{1,20}",
    placeholder: "Unsigned 64-bit integer",
    inputMode: "numeric",
  },
  hash: {
    maxLength: 64,
    pattern: "[0-9a-fA-F]{64}",
    placeholder: "64 hexadecimal characters",
  },
};

export default function App() {
  const [activeTab, setActiveTab] = useState("Wallet");
  const [publicKey, setPublicKey] = useState(null);
  const [networkId, setNetworkId] = useState(getActiveNetworkId());
  const [freighterInstalled, setFreighterInstalled] = useState(null);
  const [balances, setBalances] = useState([]);
  const [liquidityPools, setLiquidityPools] = useState({});
  const [transactions, setTransactions] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState("");
  const [toast, setToast] = useState(null);
  const [sendForm, setSendForm] = useState({
    destination: "",
    amount: "",
    assetKey: "native",
    memoType: "text",
    memo: "",
  });
  const [trustForm, setTrustForm] = useState({ code: "", issuer: "", limit: "1000000" });
  const [pathForm, setPathForm] = useState({
    mode: "strictSend",
    destination: "",
    amount: "",
    bound: "",
    sendAssetType: "native",
    sendCode: "",
    sendIssuer: "",
    destAssetType: "native",
    destCode: "",
    destIssuer: "",
    path: "",
  });
  const [pathResult, setPathResult] = useState(null);
  const [unsignedEnvelope, setUnsignedEnvelope] = useState(null);
  const [labInfo, setLabInfo] = useState(null);
  const [labError, setLabError] = useState(null);
  const [labState, setLabState] = useState(null);
  const [labStateError, setLabStateError] = useState(null);
  const [registerForm, setRegisterForm] = useState({ name: "" });
  const [lastRegisterTx, setLastRegisterTx] = useState(null);
  const [inspectForm, setInspectForm] = useState({ xdr: "" });
  const [inspectResult, setInspectResult] = useState(null);
  const [inspectError, setInspectError] = useState(null);
  const tabRefs = useRef([]);
  const [accountDetails, setAccountDetails] = useState(null);
  const [failedSubmits, setFailedSubmits] = useState([]);
  const failedSubmitLogRef = useRef(createFailedSubmitLog());
  const [webAuthForm, setWebAuthForm] = useState({ endpoint: "", serverAccount: "" });
  const [webAuthResult, setWebAuthResult] = useState(null);
  const [webAuthError, setWebAuthError] = useState(null);
  const [issuerInput, setIssuerInput] = useState("");
  const [issuerResult, setIssuerResult] = useState(null);
  const [issuerError, setIssuerError] = useState(null);
  const [streamedPayments, setStreamedPayments] = useState([]);
  const [streamState, setStreamState] = useState(null);
  const [txWatch, setTxWatch] = useState(null);
  const [txWatchError, setTxWatchError] = useState(null);
  const [hashForm, setHashForm] = useState("");
  const [hashError, setHashError] = useState(null);
  const streamSessionRef = useRef(null);
  const watchTokenRef = useRef(0);

  // Issue #512: the controller owns the streamed payments and their paging
  // tokens, so a duplicate event can never reach the list twice; this only
  // mirrors its state into React.
  const paymentStream = useMemo(
    () =>
      createPaymentStreamController({
        onChange: (records, state) => {
          setStreamedPayments(records);
          setStreamState(state);
        },
      }),
    []
  );

  const showToast = (message, type = "success", explorerUrl = null) => {
    setToast({ message, type, explorerUrl });
    setTimeout(() => setToast(null), 4200);
  };

  /** Append a failed submit to the in-memory session list (not localStorage). */
  const trackFailedSubmit = (operationType, error) => {
    failedSubmitLogRef.current.record({
      operationType,
      network: getActiveNetworkId(),
      result: submitFailureResult(error),
    });
    setFailedSubmits(failedSubmitLogRef.current.list());
  };

  const handleDownloadFailedSubmits = () => {
    if (failedSubmits.length === 0) return;
    downloadFailedSubmitLog(failedSubmitLogRef.current);
  };

  const xlmBalance = balances.find((b) => b.isNative)?.balance ?? null;
  const assetBalances = balances.filter((b) => !b.isPoolShare);
  const poolShares = poolShareRows(balances, liquidityPools);
  const memoField = MEMO_FIELDS[sendForm.memoType];
  const activeNetwork = NETWORKS[networkId];
  const friendbotAvailable = isFriendbotAvailable();
  const pathModeField = PATH_MODE_FIELDS[pathForm.mode];
  const updatePathForm = (changes) => setPathForm((prev) => ({ ...prev, ...changes }));
  // Any edit changes the operation list, so the previewed envelope is stale.
  const updateSendForm = (changes) => {
    setSendForm((prev) => ({ ...prev, ...changes }));
    setUnsignedEnvelope(null);
  };
  const selectedSendAsset = balances.find((b) => b.key === sendForm.assetKey);

  useEffect(() => {
    checkFreighterInstalled().then(setFreighterInstalled);
  }, []);

  // A pool-share balance only says how many shares the account holds. Load
  // each pool so the panel can also show both reserves and the total shares.
  useEffect(() => {
    const poolIds = [
      ...new Set(
        balances.filter((b) => b.isPoolShare && b.poolId).map((b) => b.poolId)
      ),
    ];

    if (poolIds.length === 0) return;

    let cancelled = false;
    for (const poolId of poolIds) {
      getLiquidityPool(poolId)
        .then((pool) => {
          if (!cancelled) {
            setLiquidityPools((previous) => ({ ...previous, [poolId]: pool }));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLiquidityPools((previous) => ({ ...previous, [poolId]: null }));
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [balances]);

  // Issue #512: payments stream only while the history tab is open on a
  // connected account. Every way the issue closes the stream names itself here,
  // and a network switch is handled by `start`, which closes the old stream
  // before opening the new one.
  useEffect(() => {
    const previous = streamSessionRef.current;

    if (activeTab !== "History" || !publicKey) {
      if (paymentStream.isOpen()) {
        paymentStream.stop(
          !publicKey
            ? "disconnect"
            : previous?.networkId !== networkId
              ? "network-change"
              : "tab-hidden"
        );
      }
      streamSessionRef.current = null;
      return;
    }

    if (
      paymentStream.isOpen() &&
      previous &&
      previous.publicKey === publicKey &&
      previous.networkId === networkId
    ) {
      return;
    }

    streamSessionRef.current = { publicKey, networkId };
    try {
      paymentStream.start({ publicKey, networkId });
    } catch (err) {
      paymentStream.fail(err);
    }
  }, [activeTab, publicKey, networkId, paymentStream]);

  useEffect(
    () => () => {
      if (paymentStream.isOpen()) paymentStream.stop("tab-hidden");
      streamSessionRef.current = null;
    },
    [paymentStream]
  );

  // Issue #513: one watch runs at a time, so a token makes an older watch's
  // remaining polls invisible instead of letting two hashes fight over the box.
  const startTxWatch = useCallback(
    (hash) => {
      const token = watchTokenRef.current + 1;
      watchTokenRef.current = token;
      setTxWatchError(null);
      setTxWatch({
        hash,
        attempts: 0,
        ...txStatusPresentation({
          status: "pending",
          explorerUrl: buildTransactionExplorerUrl(networkId, hash),
        }),
      });

      watchTransactionStatus({
        hash,
        networkId,
        onUpdate: (snapshot) => {
          if (watchTokenRef.current !== token) return;
          setTxWatch({ ...snapshot, ...txStatusPresentation(snapshot) });
        },
      }).catch((err) => {
        if (watchTokenRef.current !== token) return;
        setTxWatch(null);
        setTxWatchError(err.message || "The transaction watch could not read this hash.");
      });
    },
    [networkId]
  );

  const refreshBalances = useCallback(async () => {
    if (!publicKey) return;
    setLoading("balance");
    try {
      const next = await getAccountBalances(publicKey);
      setBalances(next);
      try {
        const details = await getAccountDetails(publicKey);
        setAccountDetails(details);
      } catch {
        setAccountDetails(null);
      }
    } catch {
      setBalances([]);
      showToast("Account not found on Testnet yet. Fund it with Friendbot.", "error");
    } finally {
      setLoading("");
    }
  }, [publicKey]);

  const handleConnect = async () => {
    setLoading("connect");
    try {
      const address = await connectFreighterWallet();
      setPublicKey(address);
      setBalances([]);
      setTransactions([]);
      showToast("Freighter connected.");
      try {
        const next = await getAccountBalances(address);
        setBalances(next);
      } catch {
        /* unfunded until Friendbot */
      }
    } catch (e) {
      showToast(e.message || "Failed to connect Freighter.", "error");
    } finally {
      setLoading("");
    }
  };

  const handleDisconnect = () => {
    failedSubmitLogRef.current.clear();
    setFailedSubmits([]);
    setPublicKey(null);
    setBalances([]);
    setTransactions([]);
    setAccountDetails(null);
    showToast("Disconnected.");
  };

  const handleNetworkChange = (id) => {
    try {
      const next = setActiveNetwork(id);
      setNetworkId(id);
      setBalances([]);
      setTransactions([]);
      setAccountDetails(null);
      setInspectResult(null);
      setInspectError(null);
      showToast(`Switched to ${next.label}. Refresh to load balances.`, "info");
      if (publicKey) refreshBalances();
    } catch (e) {
      showToast(e.message || "Could not switch network.", "error");
    }
  };

  const handleFund = async () => {
    if (!publicKey) return showToast("Connect Freighter first.", "error");
    setLoading("fund");
    try {
      await fundWithFriendbot(publicKey);
      const next = await getAccountBalances(publicKey);
      setBalances(next);
      showToast("Funded with Testnet XLM via Friendbot.");
    } catch (e) {
      showToast(e.message || "Funding failed.", "error");
    } finally {
      setLoading("");
    }
  };

  const handleTrust = async (e) => {
    e.preventDefault();
    if (!publicKey) return showToast("Connect Freighter first.", "error");
    if (!trustForm.issuer) {
      return showToast("Issuer is required.", "error");
    }
    let code;
    try {
      code = validateAssetCode(trustForm.code);
    } catch (err) {
      return showToast(err.message, "error");
    }
    setLoading("trust");
    try {
      const result = await changeTrustWithFreighter(
        publicKey,
        code,
        trustForm.issuer,
        trustForm.limit || "1000000"
      );
      const next = await getAccountBalances(publicKey);
      setBalances(next);
      setTrustForm({ code: "", issuer: "", limit: "1000000" });
      showToast(`Trustline for ${code} submitted.`);
      startTxWatch(result.hash);
    } catch (err) {
      trackFailedSubmit("changeTrust", err);
      showToast(err.message || "Change trust failed.", "error");
    } finally {
      setLoading("");
    }
  };

  const handleRemoveTrust = async (asset) => {
    if (!publicKey) return showToast("Connect Freighter first.", "error");
    if (parseFloat(asset.balance) > 0) {
      return showToast(
        `${asset.code} still holds a balance. Move it to 0 before removing the trustline.`,
        "error"
      );
    }

    setLoading(`remove-${asset.key}`);
    try {
      const result = await changeTrustWithFreighter(publicKey, asset.code, asset.issuer, "0");
      const next = await getAccountBalances(publicKey);
      setBalances(next);
      showToast(`${asset.code} trustline removed.`);
      startTxWatch(result.hash);
    } catch (err) {
      trackFailedSubmit("changeTrust", err);
      showToast(err.message || `Could not remove the ${asset.code} trustline.`, "error");
    } finally {
      setLoading("");
    }
  };

  /** Validate the send form and return the args shared by preview and send. */
  const sendFormArgs = () => {
    if (!publicKey) {
      showToast("Connect Freighter first.", "error");
      return null;
    }
    if (!sendForm.destination) {
      showToast("Destination is required.", "error");
      return null;
    }
    let amount;
    try {
      amount = validatePaymentAmount(sendForm.amount);
    } catch (err) {
      showToast(err.message, "error");
      return null;
    }
    if (
      sendForm.memoType === "text" &&
      new TextEncoder().encode(sendForm.memo).length > 28
    ) {
      showToast("Text memos must be 28 UTF-8 bytes or fewer.", "error");
      return null;
    }

    const selected = balances.find((b) => b.key === sendForm.assetKey);
    if (!selected) {
      showToast("Choose an asset you hold a trustline for.", "error");
      return null;
    }
    if (parseFloat(amount) > parseFloat(selected.balance)) {
      showToast(
        `Insufficient ${selected.code} balance. Available: ${selected.balance}.`,
        "error"
      );
      return null;
    }

    return {
      destination: sendForm.destination,
      amount,
      asset: selected.isNative
        ? { isNative: true }
        : { isNative: false, code: selected.code, issuer: selected.issuer },
      memoType: sendForm.memoType,
      memo: sendForm.memo,
    };
  };

  const buildSendEnvelope = async () => {
    const args = sendFormArgs();
    if (!args) return null;

    return buildPaymentEnvelope(
      publicKey,
      args.destination,
      args.amount,
      args.asset,
      args.memoType,
      args.memo
    );
  };

  /** Build the unsigned envelope only: never signs and never submits. */
  const handlePreviewEnvelope = async () => {
    setLoading("preview");
    try {
      const xdr = await buildSendEnvelope();
      if (!xdr) return;
      setUnsignedEnvelope(xdr);
      showToast(
        "Unsigned envelope ready. Nothing was signed or submitted.",
        "info"
      );
    } catch (err) {
      showToast(err.message || "Could not build the unsigned envelope.", "error");
    } finally {
      setLoading("");
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    const args = sendFormArgs();
    if (!args) return;

    // Show the envelope before Freighter opens so it can be copied or handed
    // to another signer. The same XDR is signed on the next click.
    if (!unsignedEnvelope) {
      try {
        const xdr = await buildSendEnvelope();
        if (!xdr) return;
        setUnsignedEnvelope(xdr);
        showToast(
          "Review the unsigned envelope, then click Sign & send to sign this exact XDR.",
          "info"
        );
      } catch (err) {
        showToast(err.message || "Could not build the unsigned envelope.", "error");
      }
      return;
    }

    setLoading("send");
    try {
      const result = await submitEnvelopeWithFreighter(
        unsignedEnvelope,
        publicKey
      );
      const next = await getAccountBalances(publicKey);
      setBalances(next);
      setSendForm({
        destination: "",
        amount: "",
        assetKey: "native",
        memoType: "text",
        memo: "",
      });
      setUnsignedEnvelope(null);
      showToast(
        `Payment submitted · ${result.hash.slice(0, 12)}…`,
        "success",
        explorerTxUrl(result.hash)
      );
      startTxWatch(result.hash);
    } catch (err) {
      trackFailedSubmit("payment", err);
      showToast(err.message || "Payment failed.", "error");
    } finally {
      setLoading("");
    }
  };

  const handlePathPayment = async (e) => {
    e.preventDefault();
    if (!publicKey) return showToast("Connect Freighter first.", "error");
    if (!pathForm.destination || !pathForm.amount || !pathForm.bound) {
      return showToast("Destination, amount, and slippage bound are required.", "error");
    }
    if (pathForm.sendAssetType === "credit" && (!pathForm.sendCode || !pathForm.sendIssuer)) {
      return showToast("Send asset code and issuer are required.", "error");
    }
    if (pathForm.destAssetType === "credit" && (!pathForm.destCode || !pathForm.destIssuer)) {
      return showToast("Destination asset code and issuer are required.", "error");
    }

    setLoading("path");
    setPathResult(null);
    try {
      const result = await pathPaymentWithFreighter({
        publicKey,
        destination: pathForm.destination,
        mode: pathForm.mode,
        sendAsset: {
          isNative: pathForm.sendAssetType === "native",
          code: pathForm.sendCode,
          issuer: pathForm.sendIssuer,
        },
        destAsset: {
          isNative: pathForm.destAssetType === "native",
          code: pathForm.destCode,
          issuer: pathForm.destIssuer,
        },
        amount: pathForm.amount,
        destMin: pathForm.mode === "strictSend" ? pathForm.bound : undefined,
        sendMax: pathForm.mode === "strictReceive" ? pathForm.bound : undefined,
        path: pathForm.path,
      });

      setPathResult({
        hash: result.hash,
        explorerUrl: explorerTxUrl(result.hash),
      });
      try {
        const next = await getAccountBalances(publicKey);
        setBalances(next);
      } catch {
        /* balance refresh is best-effort */
      }
      showToast(`Path payment submitted · ${result.hash.slice(0, 12)}…`);
      startTxWatch(result.hash);
    } catch (err) {
      trackFailedSubmit("pathPayment", err);
      showToast(err.message || "Path payment failed.", "error");
    } finally {
      setLoading("");
    }
  };

  const handleHistory = async () => {
    if (!publicKey) return showToast("Connect Freighter first.", "error");
    setLoading("history");
    try {
      const page = await getTransactions(publicKey);
      setTransactions(page.records);
      setNextCursor(page.nextCursor);
      if (page.records.length === 0) showToast("No payments yet.", "info");
    } catch {
      showToast("Could not load payment history.", "error");
    } finally {
      setLoading("");
    }
  };

  const handleLoadMore = async () => {
    if (!publicKey || !nextCursor) return;
    setLoading("history-more");
    try {
      // Same page size as the first page; `undefined` keeps the default limit.
      const page = await getTransactions(publicKey, undefined, nextCursor);
      setTransactions((previous) => [...previous, ...page.records]);
      setNextCursor(page.nextCursor);
    } catch {
      showToast("Could not load older payments.", "error");
    } finally {
      setLoading("");
    }
  };

  // Issue #513: the same watch that follows a submit also serves a pasted hash,
  // so the hash is validated before it reaches Horizon.
  const handleWatchHash = (e) => {
    e.preventDefault();
    setHashError(null);
    let hash;
    try {
      hash = normaliseTxHash(hashForm);
    } catch (err) {
      return setHashError(err.message || "Enter the 64-character transaction hash.");
    }
    setHashForm("");
    startTxWatch(hash);
  };

  // Issue #510: the panel sends the challenge to Freighter to sign and holds
  // the returned JWT only as long as this render needs it.
  const handleWebAuth = async (e) => {
    e.preventDefault();
    if (!publicKey) return showToast("Connect Freighter first.", "error");

    setLoading("webauth");
    setWebAuthError(null);
    setWebAuthResult(null);
    try {
      const result = await completeWebAuthChallenge({
        endpoint: webAuthForm.endpoint,
        account: publicKey,
        serverAccount: webAuthForm.serverAccount,
        sign: (unsignedXdr) => signChallengeWithFreighter(unsignedXdr, publicKey),
      });
      setWebAuthResult({ requestUrl: result.requestUrl, ...result.challenge, session: result.session });
      showToast("Web authentication complete.");
    } catch (err) {
      setWebAuthError(err.message || "Web authentication failed.");
    } finally {
      setLoading("");
    }
  };

  // Issue #511: an issuer account resolves to its home domain first, so the
  // same form accepts either an account or a domain.
  const handleIssuerLookup = async (e) => {
    e.preventDefault();
    setLoading("issuer");
    setIssuerError(null);
    setIssuerResult(null);
    try {
      setIssuerResult(await loadIssuerCurrencyList({ accountOrDomain: issuerInput }));
    } catch (err) {
      setIssuerError(err.message || "Could not read the issuer's stellar.toml.");
    } finally {
      setLoading("");
    }
  };

  const requireWallet = !publicKey;
  const visibleTransactions = mergeStreamedPayments(streamedPayments, transactions);

  const loadLabInfo = async () => {
    setLoading("lab");
    setLabError(null);
    try {
      const [health, network] = await Promise.all([fetchHealth(), fetchNetworkInfo()]);
      setLabInfo({ health, network });
    } catch (e) {
      setLabInfo(null);
      setLabError(
        e.message ||
          "Backend offline. Start it with: npm run dev:backend"
      );
    } finally {
      setLoading("");
    }
  };

  const refreshLabState = useCallback(async () => {
    const contractId = labInfo?.network?.contract?.kitewell;
    if (!contractId) {
      setLabState(null);
      setLabStateError(null);
      return;
    }
    setLoading("labstate");
    setLabStateError(null);
    try {
      const state = await readKitewellState(contractId, publicKey);
      setLabState(state);
    } catch (e) {
      setLabState(null);
      setLabStateError(
        e.message || "Could not read the kitewell contract via Soroban RPC."
      );
    } finally {
      setLoading("");
    }
  }, [labInfo, publicKey]);

  const handleRegister = async (e) => {
    e.preventDefault();
    if (!publicKey) return showToast("Connect Freighter first.", "error");
    const contractId = labInfo?.network?.contract?.kitewell;
    if (!contractId) {
      return showToast(
        "No contract id configured — deploy first (contracts/README.md).",
        "error"
      );
    }
    if (!registerForm.name.trim()) {
      return showToast("Enter a builder name to register.", "error");
    }
    setLoading("register");
    try {
      const result = await registerBuilderWithFreighter(
        publicKey,
        contractId,
        registerForm.name
      );
      setLastRegisterTx(result);
      setRegisterForm({ name: "" });
      showToast(
        result.confirmed
          ? `Registered on-chain · ${result.hash.slice(0, 12)}…`
          : `Submitted · ${result.hash.slice(0, 12)}…`,
        "success"
      );
      startTxWatch(result.hash);
      const state = await readKitewellState(contractId, publicKey);
      setLabState(state);
    } catch (err) {
      trackFailedSubmit("register", err);
      showToast(err.message || "Contract invoke failed.", "error");
    } finally {
      setLoading("");
    }
  };

  const handleInspect = (event) => {
    event.preventDefault();
    setInspectError(null);
    setInspectResult(null);
    try {
      setInspectResult(
        decodeTransactionEnvelope(inspectForm.xdr, activeNetwork.passphrase)
      );
    } catch (e) {
      setInspectError(e.message || "XDR could not be read.");
    }
  };

  const activateTab = (tab) => {
    setActiveTab(tab);
    if (tab === "History") handleHistory();
    if (tab === "Lab") {
      loadLabInfo();
      refreshLabState();
    }
    if ((tab === "Wallet" || tab === "Assets" || tab === "Send") && publicKey) {
      refreshBalances();
    }
  };

  const handleTabKeyDown = (event, index) => {
    let nextIndex;

    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    else return;

    event.preventDefault();
    activateTab(TABS[nextIndex]);
    tabRefs.current[nextIndex]?.focus();
  };

  // Issue #513: one element reused by every tab that submits, because only one
  // watch runs at a time and it must be visible right where the hash appeared.
  const txWatchPanel = (
    <div className="section">
      <h2>Transaction status</h2>
      <p className="muted">
        A transaction submitted here is followed until it reaches the ledger, fails, or passes
        its max time.
      </p>

      {txWatch && (
        <div
          className={
            txWatch.status === "failed" || txWatch.status === "expired"
              ? "info-box info-box--warning"
              : "info-box"
          }
          role="status"
          aria-live="polite"
        >
          <span className="eyebrow">
            <code>{txWatch.hash}</code> · {txWatch.status}
          </span>
          <p className="muted">{txWatch.text}</p>
          <a
            className="text-link"
            href={txWatch.explorerUrl}
            target="_blank"
            rel="noreferrer"
            style={{ marginTop: 6, display: "inline-block" }}
          >
            Explorer ↗
          </a>
        </div>
      )}
      {txWatchError && (
        <div className="info-box info-box--warning">
          <span className="eyebrow">Transaction watch</span>
          <p className="muted">{txWatchError}</p>
        </div>
      )}

      <form className="form" onSubmit={handleWatchHash}>
        <label className="label" htmlFor="watch-tx-hash">
          Watch a transaction hash
        </label>
        <input
          id="watch-tx-hash"
          className="input"
          type="text"
          placeholder="64 hexadecimal characters"
          maxLength={64}
          value={hashForm}
          onChange={(e) => setHashForm(e.target.value)}
          aria-describedby="watch-tx-hash-help"
          required
        />
        <p className="muted" id="watch-tx-hash-help" role={hashError ? "alert" : undefined}>
          {hashError || "Paste any transaction hash from this network to follow it."}
        </p>
        <button className="btn btn--primary" type="submit">
          Watch status
        </button>
      </form>
    </div>
  );

  return (
    <div className="app">
      <div className="aurora" aria-hidden="true" />

      {toast && (
        <div
          className={`toast toast--${toast.type}`}
          role={toast.type === "error" ? "alert" : "status"}
          aria-live={toast.type === "error" ? "assertive" : "polite"}
          aria-atomic="true"
        >
          <span>{toast.message}</span>
          {toast.explorerUrl && (
            <a
              className="toast__link"
              href={toast.explorerUrl}
              target="_blank"
              rel="noreferrer"
            >
              View on explorer ↗
            </a>
          )}
        </div>
      )}

      <header className="header">
        <div className="header__brand">
          <KitewellMark />
          <div className="header__titles">
            <span className="header__name">Kitewell</span>
            <span className="header__tag">Stellar {activeNetwork.label} lab</span>
          </div>
        </div>
        <label className="network" htmlFor="network-select">
          <span className="eyebrow">Network</span>
          <select
            id="network-select"
            className="input input--compact"
            value={networkId}
            onChange={(e) => handleNetworkChange(e.target.value)}
            aria-label="Stellar network"
          >
            {Object.values(NETWORKS).map((network) => (
              <option key={network.id} value={network.id}>
                {network.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      <main className="main">
        <section className="hero-card">
          {publicKey ? (
            <>
              <div className="hero-card__status">
                <span className="status-dot" />
                Connected via Freighter
              </div>
              <div className="hero-card__balance">
                <span className="eyebrow">XLM balance</span>
                <span className="hero-card__amount">
                  {xlmBalance !== null
                    ? `${parseFloat(xlmBalance).toLocaleString(undefined, { maximumFractionDigits: 7 })} XLM`
                    : "—"}
                  <button
                    className="icon-btn"
                    onClick={refreshBalances}
                    disabled={loading === "balance"}
                    title="Refresh balances"
                    aria-label="Refresh balances"
                    type="button"
                  >
                    {loading === "balance" ? <Spinner size={14} /> : "↻"}
                  </button>
                </span>
              </div>
              <div className="hero-card__key">
                <span className="eyebrow">Public key</span>
                <code>{shortenAddress(publicKey)}</code>
                <button
                  className="icon-btn"
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(publicKey);
                    showToast("Address copied.");
                  }}
                  title="Copy public key"
                  aria-label="Copy public key"
                >
                  ⎘
                </button>
                <a
                  className="text-link"
                  href={explorerAccountUrl(publicKey)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Explorer ↗
                </a>
              </div>
              {balances.filter((b) => !b.isNative).length > 0 && (
                <div className="asset-chips">
                  {balances
                    .filter((b) => !b.isNative && !b.isPoolShare)
                    .slice(0, 6)
                    .map((b) => (
                      <span key={b.key} className="chip">
                        {parseFloat(b.balance).toLocaleString(undefined, {
                          maximumFractionDigits: 4,
                        })}{" "}
                        {b.code}
                      </span>
                    ))}
                </div>
              )}
            </>
          ) : (
            <div className="hero-card__empty">
              <p className="hero-card__lead">No wallet connected</p>
              <p className="muted">
                Connect Freighter to fund, trust assets, and send Testnet XLM.
              </p>
            </div>
          )}
        </section>

        <nav className="tabs" aria-label="Lab sections" role="tablist">
          {TABS.map((t, index) => {
            const isActive = activeTab === t;
            const tabId = `tab-${tabSlug(t)}`;

            return (
              <button
                key={t}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                id={tabId}
                type="button"
                role="tab"
                className={`tab ${isActive ? "tab--active" : ""}`}
                aria-selected={isActive}
                aria-controls={`panel-${t.toLowerCase()}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => activateTab(t)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {t}
              </button>
            );
          })}
        </nav>

        <section
          className="panel"
          id={`panel-${tabSlug(activeTab)}`}
          role="tabpanel"
          aria-labelledby={`tab-${tabSlug(activeTab)}`}
          tabIndex={0}
        >
          {activeTab === "Wallet" && (
            <div className="section">
              <h2>Connect wallet</h2>
              {freighterInstalled === false && (
                <div className="info-box info-box--warning">
                  <span className="eyebrow">Freighter not detected</span>
                  <p className="muted">
                    Install the{" "}
                    <a href="https://www.freighter.app/" target="_blank" rel="noreferrer">
                      Freighter extension
                    </a>{" "}
                    and switch it to <strong>Testnet</strong>.
                  </p>
                </div>
              )}
              {requireWallet ? (
                <>
                  <p className="muted">
                    Kitewell requests access with Freighter&apos;s{" "}
                    <code>setAllowed</code> / <code>getAddress</code> APIs. Keys never leave
                    the extension.
                  </p>
                  <button
                    className="btn btn--primary"
                    type="button"
                    onClick={handleConnect}
                    disabled={loading === "connect" || freighterInstalled === false}
                  >
                    {loading === "connect" ? (
                      <>
                        <Spinner /> Connecting…
                      </>
                    ) : (
                      "Connect Freighter"
                    )}
                  </button>
                </>
              ) : (
                <>
                  <div className="info-box">
                    <span className="eyebrow">Connected address</span>
                    <code>{publicKey}</code>
                  </div>
                  {accountDetails && (
                    <div className="info-box">
                      <span className="eyebrow">Account metadata</span>
                      <div className="metadata-grid">
                        <div>
                          <span className="metadata-label">Sequence</span>
                          <span className="metadata-value">{accountDetails.sequence}</span>
                        </div>
                        <div>
                          <span className="metadata-label">Subentries</span>
                          <span className="metadata-value">{accountDetails.subentryCount}</span>
                        </div>
                        <div>
                          <span className="metadata-label">Thresholds</span>
                          <span className="metadata-value">
                            {accountDetails.thresholds?.low ? accountDetails.thresholds.low : "—"},
                            {accountDetails.thresholds?.medium ? accountDetails.thresholds.medium : "—"},
                            {accountDetails.thresholds?.high ? accountDetails.thresholds.high : "—"}
                          </span>
                        </div>
                      </div>
                      <a
                        href={explorerAccountUrl(publicKey)}
                        className="text-link"
                        target="_blank"
                        rel="noreferrer"
                        style={{ marginTop: 8, display: "inline-block" }}
                      >
                        StellarExpert ↗
                      </a>
                    </div>
                  )}
                  <button className="btn btn--secondary" type="button" onClick={handleDisconnect}>
                    Disconnect
                  </button>
                </>
              )}
            </div>
          )}

          {activeTab === "Fund" && (
            <div className="section">
              <h2>Fund with Friendbot</h2>
              <p className="muted">
                Activate the account and receive free test XLM. Only available on Testnet.
              </p>
              {!friendbotAvailable && (
                <div className="info-box info-box--warning">
                  <span className="eyebrow">Friendbot unavailable</span>
                  <p className="muted">
                    Friendbot is disabled on {activeNetwork.label}. Switch to Testnet to fund an
                    account here, or fund it through a {activeNetwork.label} faucet.
                  </p>
                </div>
              )}
              {publicKey && (
                <div className="info-box">
                  <span className="eyebrow">Funding address</span>
                  <code>{publicKey}</code>
                </div>
              )}
              <button
                className="btn btn--primary"
                type="button"
                onClick={handleFund}
                disabled={loading === "fund" || requireWallet || !friendbotAvailable}
              >
                {loading === "fund" ? (
                  <>
                    <Spinner /> Funding…
                  </>
                ) : (
                  "Request Friendbot XLM"
                )}
              </button>
            </div>
          )}

          {activeTab === "Assets" && (
            <div className="section">
              <h2>Balances & trustlines</h2>
              <p className="muted">
                View holdings, open a trustline, or remove an empty one with Freighter{" "}
                <code>signTransaction</code>. Removing sets the limit to 0.
              </p>

              {assetBalances.length > 0 ? (
                <ul className="balance-list">
                  {assetBalances.map((b) => (
                    <li key={b.key} className="balance-row">
                      <div>
                        <strong>{b.code}</strong>
                        {!b.isNative && (
                          <span className="muted balance-row__issuer">
                            {shortenAddress(b.issuer)}
                          </span>
                        )}
                      </div>
                      <div className="balance-row__actions">
                        <span>
                          {parseFloat(b.balance).toLocaleString(undefined, {
                            maximumFractionDigits: 7,
                          })}
                        </span>
                        {!b.isNative && (
                          <button
                            className="btn btn--secondary btn--sm"
                            type="button"
                            onClick={() => handleRemoveTrust(b)}
                            disabled={loading === `remove-${b.key}`}
                            title={
                              parseFloat(b.balance) > 0
                                ? "Balance must be 0 before removing this trustline"
                                : `Remove the ${b.code} trustline`
                            }
                          >
                            {loading === `remove-${b.key}`
                              ? "Removing…"
                              : "Remove"}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  {requireWallet
                    ? "Connect a wallet to load balances."
                    : "No balances yet — fund the account first."}
                </p>
              )}

              {poolShares.length > 0 && (
                <div className="section">
                  <h3 className="subhead">Liquidity pool shares</h3>
                  {poolShares.map((row) => (
                    <div key={row.poolId} className="info-box">
                      <span className="eyebrow">Pool {shortenAddress(row.poolId)}</span>
                      <div className="metadata-grid">
                        <div>
                          <span className="metadata-label">Your shares</span>
                          <span className="metadata-value">{row.shares}</span>
                        </div>
                        <div>
                          <span className="metadata-label">Total shares</span>
                          <span className="metadata-value">
                            {row.totalShares ?? "—"}
                          </span>
                        </div>
                        <div>
                          <span className="metadata-label">Your share</span>
                          <span className="metadata-value">
                            {row.percentage !== null ? `${row.percentage}%` : "—"}
                          </span>
                        </div>
                      </div>
                      {row.loading ? (
                        <p className="muted">Loading pool reserves…</p>
                      ) : row.reservesUnavailable ? (
                        <p className="muted">
                          Reserves unavailable — Horizon could not load this pool.
                        </p>
                      ) : (
                        <div className="metadata-grid">
                          {row.reserves.map((reserve) => (
                            <div key={reserve.label}>
                              <span className="metadata-label">{reserve.label}</span>
                              <span className="metadata-value">{reserve.balance}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={handleTrust} className="form">
                <h3 className="subhead">Add trustline</h3>
                <label className="label" htmlFor="trust-asset-code">
                  Asset code
                </label>
                <input
                  id="trust-asset-code"
                  className="input"
                  value={trustForm.code}
                  onChange={(e) => setTrustForm({ ...trustForm, code: e.target.value })}
                  placeholder="USDC"
                  maxLength={12}
                  required
                />
                <label className="label" htmlFor="trust-issuer">
                  Issuer
                </label>
                <input
                  id="trust-issuer"
                  className="input"
                  value={trustForm.issuer}
                  onChange={(e) => setTrustForm({ ...trustForm, issuer: e.target.value })}
                  placeholder="G…"
                  required
                />
                <label className="label" htmlFor="trust-limit">
                  Limit
                </label>
                <input
                  id="trust-limit"
                  className="input"
                  type="number"
                  min="0"
                  step="any"
                  value={trustForm.limit}
                  onChange={(e) => setTrustForm({ ...trustForm, limit: e.target.value })}
                />
                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={loading === "trust" || requireWallet}
                >
                  {loading === "trust" ? (
                    <>
                      <Spinner /> Signing…
                    </>
                  ) : (
                    "Sign changeTrust"
                  )}
                </button>
              </form>

              {txWatchPanel}
            </div>
          )}

          {activeTab === "Send" && (
            <div className="section">
              <h2>Send payment</h2>
              <p className="muted">
                Builds a payment op for XLM or a credit asset you hold. Review the unsigned
                envelope XDR, then sign in Freighter to submit it to Horizon Testnet.
              </p>
              <form onSubmit={handleSend} className="form">
                <label className="label" htmlFor="send-destination">
                  Destination
                </label>
                <input
                  id="send-destination"
                  className="input"
                  type="text"
                  placeholder="G…"
                  value={sendForm.destination}
                  onChange={(e) => updateSendForm({ destination: e.target.value })}
                  required
                />
                <label className="label" htmlFor="send-asset">
                  Asset
                </label>
                <select
                  id="send-asset"
                  className="input"
                  value={sendForm.assetKey}
                  onChange={(e) => updateSendForm({ assetKey: e.target.value })}
                >
                  <option value="native">XLM (native)</option>
                  {balances
                    .filter((b) => !b.isNative && !b.isPoolShare)
                    .map((b) => (
                      <option key={b.key} value={b.key}>
                        {b.code} ·{" "}
                        {parseFloat(b.balance).toLocaleString(undefined, {
                          maximumFractionDigits: 4,
                        })}
                      </option>
                    ))}
                </select>
                <label className="label" htmlFor="send-amount">
                  Amount ({selectedSendAsset?.code ?? "XLM"})
                </label>
                <input
                  id="send-amount"
                  className="input"
                  type="number"
                  step="0.0000001"
                  min="0.0000001"
                  placeholder="e.g. 10"
                  value={sendForm.amount}
                  onChange={(e) => updateSendForm({ amount: e.target.value })}
                  required
                />
                <label className="label" htmlFor="send-memo-type">
                  Memo type
                </label>
                <select
                  id="send-memo-type"
                  className="input"
                  value={sendForm.memoType}
                  onChange={(e) =>
                    updateSendForm({ memoType: e.target.value, memo: "" })
                  }
                >
                  <option value="text">Text</option>
                  <option value="id">ID</option>
                  <option value="hash">Hash</option>
                </select>
                <label className="label" htmlFor="send-memo">
                  Memo (optional)
                </label>
                <input
                  id="send-memo"
                  className="input"
                  type="text"
                  maxLength={memoField.maxLength}
                  pattern={memoField.pattern}
                  inputMode={memoField.inputMode}
                  placeholder={memoField.placeholder}
                  value={sendForm.memo}
                  onChange={(e) => updateSendForm({ memo: e.target.value })}
                />
                {unsignedEnvelope && (
                  <div className="info-box">
                    <span className="eyebrow">Unsigned envelope XDR</span>
                    <code style={{ wordBreak: "break-all" }}>
                      {unsignedEnvelope}
                    </code>
                    <p className="muted">
                      Copy this envelope to hand it to another signer or the decoder.
                      Copying does not sign or submit it.
                    </p>
                    <button
                      className="btn btn--secondary btn--sm"
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(unsignedEnvelope);
                        showToast(
                          "Unsigned envelope copied. Nothing was signed or submitted.",
                          "info"
                        );
                      }}
                    >
                      Copy XDR
                    </button>
                  </div>
                )}
                <div className="section__row">
                  <button
                    className="btn btn--secondary"
                    type="button"
                    onClick={handlePreviewEnvelope}
                    disabled={loading === "preview" || requireWallet}
                  >
                    {loading === "preview" ? (
                      <>
                        <Spinner /> Building…
                      </>
                    ) : (
                      "Build unsigned envelope"
                    )}
                  </button>
                  <button
                    className="btn btn--primary"
                    type="submit"
                    disabled={loading === "send" || loading === "preview" || requireWallet}
                  >
                    {loading === "send" ? (
                      <>
                        <Spinner /> Signing in Freighter…
                      </>
                    ) : (
                      "Sign & send"
                    )}
                  </button>
                </div>
              </form>

              {txWatchPanel}
            </div>
          )}

          {activeTab === "Path" && (
            <div className="section">
              <h2>Path payment</h2>
              <p className="muted">
                Builds a <code>pathPaymentStrictSend</code> /{" "}
                <code>pathPaymentStrictReceive</code> op, signs it in Freighter, then submits
                it to Horizon Testnet.
              </p>
              <form onSubmit={handlePathPayment} className="form">
                <label className="label" htmlFor="path-mode">
                  Mode
                </label>
                <select
                  id="path-mode"
                  className="input"
                  value={pathForm.mode}
                  onChange={(e) => updatePathForm({ mode: e.target.value })}
                >
                  <option value="strictSend">Strict send — fix the amount sent</option>
                  <option value="strictReceive">Strict receive — fix the amount received</option>
                </select>

                <label className="label" htmlFor="path-destination">
                  Destination
                </label>
                <input
                  id="path-destination"
                  className="input"
                  type="text"
                  placeholder="G…"
                  value={pathForm.destination}
                  onChange={(e) => updatePathForm({ destination: e.target.value })}
                  required
                />

                <label className="label" htmlFor="path-send-asset">
                  Send asset
                </label>
                <select
                  id="path-send-asset"
                  className="input"
                  value={pathForm.sendAssetType}
                  onChange={(e) => updatePathForm({ sendAssetType: e.target.value })}
                >
                  <option value="native">XLM (native)</option>
                  <option value="credit">Credit asset</option>
                </select>
                {pathForm.sendAssetType === "credit" && (
                  <>
                    <input
                      className="input"
                      type="text"
                      placeholder="Asset code, e.g. USDC"
                      maxLength={12}
                      value={pathForm.sendCode}
                      onChange={(e) => updatePathForm({ sendCode: e.target.value })}
                      required
                    />
                    <input
                      className="input"
                      type="text"
                      placeholder="Send asset issuer G…"
                      value={pathForm.sendIssuer}
                      onChange={(e) => updatePathForm({ sendIssuer: e.target.value })}
                      required
                    />
                  </>
                )}

                <label className="label" htmlFor="path-dest-asset">
                  Destination asset
                </label>
                <select
                  id="path-dest-asset"
                  className="input"
                  value={pathForm.destAssetType}
                  onChange={(e) => updatePathForm({ destAssetType: e.target.value })}
                >
                  <option value="native">XLM (native)</option>
                  <option value="credit">Credit asset</option>
                </select>
                {pathForm.destAssetType === "credit" && (
                  <>
                    <input
                      className="input"
                      type="text"
                      placeholder="Asset code, e.g. USDC"
                      maxLength={12}
                      value={pathForm.destCode}
                      onChange={(e) => updatePathForm({ destCode: e.target.value })}
                      required
                    />
                    <input
                      className="input"
                      type="text"
                      placeholder="Destination asset issuer G…"
                      value={pathForm.destIssuer}
                      onChange={(e) => updatePathForm({ destIssuer: e.target.value })}
                      required
                    />
                  </>
                )}

                <label className="label" htmlFor="path-amount">
                  {pathModeField.amountLabel}
                </label>
                <input
                  id="path-amount"
                  className="input"
                  type="number"
                  step="0.0000001"
                  min="0.0000001"
                  placeholder="e.g. 10"
                  value={pathForm.amount}
                  onChange={(e) => updatePathForm({ amount: e.target.value })}
                  required
                />

                <label className="label" htmlFor="path-bound">
                  {pathModeField.boundLabel}
                </label>
                <input
                  id="path-bound"
                  className="input"
                  type="number"
                  step="0.0000001"
                  min="0.0000001"
                  placeholder="e.g. 9.5"
                  value={pathForm.bound}
                  onChange={(e) => updatePathForm({ bound: e.target.value })}
                  required
                />
                <p className="muted">{pathModeField.boundHint}</p>

                <label className="label" htmlFor="path-hops">
                  Intermediate path (optional)
                </label>
                <input
                  id="path-hops"
                  className="input"
                  type="text"
                  placeholder="CODE:ISSUER, CODE:ISSUER"
                  value={pathForm.path}
                  onChange={(e) => updatePathForm({ path: e.target.value })}
                />
                <p className="muted">
                  Leave empty to route through the direct order book. Intermediate hops add a
                  fixed path to the operation.
                </p>

                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={loading === "path" || requireWallet}
                >
                  {loading === "path" ? (
                    <>
                      <Spinner /> Signing in Freighter…
                    </>
                  ) : (
                    "Sign & submit path payment"
                  )}
                </button>
              </form>

              {pathResult && (
                <div className="info-box">
                  <span className="eyebrow">Path payment submitted</span>
                  <code>{pathResult.hash}</code>
                  <a
                    className="text-link"
                    href={pathResult.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ marginTop: 6, display: "inline-block" }}
                  >
                    View on StellarExpert ↗
                  </a>
                </div>
              )}

              {txWatchPanel}
            </div>
          )}

          {activeTab === "Inspect" && (
            <div className="section">
              <div className="section__row">
                <h2>Inspect transaction</h2>
              </div>
              <p className="muted">
                Paste a base64 transaction envelope to read it before signing. It is
                decoded locally on {activeNetwork.label}; nothing is submitted.
              </p>
              <form className="form" onSubmit={handleInspect}>
                <label className="label" htmlFor="inspect-xdr">
                  Transaction envelope (base64 XDR)
                </label>
                <textarea
                  id="inspect-xdr"
                  className="input"
                  rows={5}
                  spellCheck={false}
                  placeholder="AAAAAgAAAAA..."
                  value={inspectForm.xdr}
                  onChange={(e) =>
                    setInspectForm({ ...inspectForm, xdr: e.target.value })
                  }
                />
                <button className="btn btn--primary" type="submit">
                  Decode
                </button>
              </form>
              {inspectError && (
                <div className="info-box info-box--warning" role="alert">
                  <span className="eyebrow">Could not decode</span>
                  <p className="muted">{inspectError}</p>
                </div>
              )}
              {inspectResult && <DecodedEnvelope decoded={inspectResult} />}
              {!inspectResult && !inspectError && (
                <p className="muted">
                  The source, fee, sequence, memo, time bounds, and one block per
                  operation will appear here.
                </p>
              )}
            </div>
          )}

          {activeTab === "Lab" && (
            <div className="section">
              <div className="section__row">
                <h2>Lab stack</h2>
                <button
                  className="btn btn--secondary"
                  type="button"
                  onClick={loadLabInfo}
                  disabled={loading === "lab"}
                >
                  {loading === "lab" ? (
                    <>
                      <Spinner /> Checking…
                    </>
                  ) : (
                    "Refresh"
                  )}
                </button>
              </div>
              <p className="muted">
                Kitewell is a monorepo: <code>frontend</code> · <code>backend</code> ·{" "}
                <code>contracts</code>. This panel reads the local API and contract config.
              </p>
              {labError && (
                <div className="info-box info-box--warning">
                  <span className="eyebrow">Backend</span>
                  <p className="muted">{labError}</p>
                </div>
              )}
              {labInfo && (
                <>
                  <div className="info-box">
                    <span className="eyebrow">Backend health</span>
                    <code>
                      {labInfo.health.service} · {labInfo.health.network} · ok=
                      {String(labInfo.health.ok)}
                    </code>
                  </div>
                  <div className="info-box">
                    <span className="eyebrow">Horizon</span>
                    <code>{labInfo.network.horizonUrl}</code>
                  </div>
                  <div className="info-box">
                    <span className="eyebrow">Soroban · kitewell</span>
                    <code>
                      {labInfo.network.contract?.kitewell ||
                        "Not deployed yet — see contracts/README.md"}
                    </code>
                    <p className="muted" style={{ marginTop: 6 }}>
                      Status: {labInfo.network.contract?.status}
                    </p>
                  </div>
                  <div className="section__row">
                    <div className="subhead">On-chain registry</div>
                    <button
                      className="btn btn--secondary"
                      type="button"
                      onClick={refreshLabState}
                      disabled={loading === "labstate"}
                    >
                      {loading === "labstate" ? (
                        <>
                          <Spinner /> Reading…
                        </>
                      ) : (
                        "Refresh"
                      )}
                    </button>
                  </div>
                  {labState ? (
                    <div className="info-box">
                      <span className="eyebrow">Contract state</span>
                      <div className="metadata-grid">
                        <div>
                          <span className="metadata-label">lab_name</span>
                          <span className="metadata-value">{labState.labName ?? "—"}</span>
                        </div>
                        <div>
                          <span className="metadata-label">builder_count</span>
                          <span className="metadata-value">{labState.builderCount ?? 0}</span>
                        </div>
                        <div>
                          <span className="metadata-label">get_builder (you)</span>
                          <span className="metadata-value">
                            {publicKey ? labState.builder ?? "Not registered" : "Connect to check"}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="muted">
                      Reads lab_name, builder_count, and get_builder via Soroban RPC.
                    </p>
                  )}
                  {labStateError && (
                    <div className="info-box info-box--warning">
                      <span className="eyebrow">Soroban RPC</span>
                      <p className="muted">{labStateError}</p>
                    </div>
                  )}
                  <form className="form" onSubmit={handleRegister}>
                    <label className="label" htmlFor="builder-name">
                      Builder name
                    </label>
                    <input
                      id="builder-name"
                      className="input"
                      maxLength={64}
                      placeholder="e.g. stellar-alice"
                      value={registerForm.name}
                      onChange={(e) =>
                        setRegisterForm({ ...registerForm, name: e.target.value })
                      }
                    />
                    <button
                      className="btn btn--primary"
                      type="submit"
                      disabled={loading === "register" || requireWallet}
                    >
                      {loading === "register" ? (
                        <>
                          <Spinner /> Signing in Freighter…
                        </>
                      ) : (
                        "Sign & register"
                      )}
                    </button>
                    {!publicKey && <p className="muted">Connect Freighter to sign.</p>}
                  </form>
                  {lastRegisterTx && (
                    <div className="info-box">
                      <span className="eyebrow">Register tx</span>
                      <code>{lastRegisterTx.hash}</code>
                      <a
                        href={explorerTxUrl(lastRegisterTx.hash)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-link"
                      >
                        Explorer ↗
                      </a>
                    </div>
                  )}
                </>
              )}
              {!labInfo && !labError && (
                <p className="muted">Open this tab to probe the backend.</p>
              )}
              <div className="info-box">
                <span className="eyebrow">Failed submits</span>
                <p className="muted">
                  {failedSubmits.length === 0
                    ? "No failed submits this session yet."
                    : `${failedSubmits.length} failed submission${
                        failedSubmits.length === 1 ? "" : "s"
                      } this session. Cleared on disconnect or reload — not stored in localStorage.`}
                </p>
                <button
                  className="btn btn--secondary"
                  type="button"
                  onClick={handleDownloadFailedSubmits}
                  disabled={failedSubmits.length === 0}
                >
                  Download failed JSON
                </button>
              </div>

              {txWatchPanel}
            </div>
          )}

          {activeTab === "History" && (
            <div className="section">
              <div className="section__row">
                <h2>Payment history</h2>
                <button
                  className="btn btn--secondary"
                  type="button"
                  onClick={handleHistory}
                  disabled={loading === "history" || requireWallet}
                >
                  {loading === "history" ? (
                    <>
                      <Spinner /> Loading…
                    </>
                  ) : (
                    "Refresh"
                  )}
                </button>
              </div>
              <p className="muted" aria-live="polite">
                {streamStatusLabel(streamState)}
              </p>
              {visibleTransactions.length > 0 ? (
                <div className="tx-list">
                  {visibleTransactions.map((tx) => {
                    const isOutgoing = tx.from === publicKey;
                    const createdAt = formatCreatedAt(tx.created_at);
                    return (
                      <div
                        key={tx.id}
                        className={`tx-item ${isOutgoing ? "tx-item--out" : "tx-item--in"}`}
                      >
                        <div className="tx-item__direction">
                          {isOutgoing ? "Sent" : "Received"}
                        </div>
                        <div className="tx-item__amount">
                          {parseFloat(tx.amount).toLocaleString()} {tx.asset_code || "XLM"}
                        </div>
                        <div className="tx-item__addr muted">
                          {isOutgoing
                            ? `To ${shortenAddress(tx.to)}`
                            : `From ${shortenAddress(tx.from)}`}
                        </div>
                        <a
                          href={explorerTxUrl(tx.transaction_hash)}
                          target="_blank"
                          rel="noreferrer"
                          className="tx-item__link"
                        >
                          Explorer ↗
                        </a>
                        {createdAt && (
                          <time
                            className="tx-item__time"
                            dateTime={tx.created_at}
                          >
                            {createdAt}
                          </time>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                !loading && <p className="muted">No payments yet.</p>
              )}
              {nextCursor && (
                <div className="section__row">
                  <button
                    className="btn btn--secondary"
                    type="button"
                    onClick={handleLoadMore}
                    disabled={loading === "history-more"}
                  >
                    {loading === "history-more" ? (
                      <>
                        <Spinner /> Loading…
                      </>
                    ) : (
                      "Load more"
                    )}
                  </button>
                </div>
              )}

              {txWatchPanel}
            </div>
          )}

          {activeTab === "Issuer" && (
            <div className="section">
              <h2>Issuer stellar.toml</h2>
              <p className="muted">
                An issuer account is looked up for the home domain it publishes, then that
                domain&apos;s stellar.toml is read over HTTPS only. A file that does not parse
                shows the failure and no rows.
              </p>

              <form className="form" onSubmit={handleIssuerLookup}>
                <label className="label" htmlFor="issuer-account-or-domain">
                  Issuer account or home domain
                </label>
                <input
                  id="issuer-account-or-domain"
                  className="input"
                  type="text"
                  placeholder="G… or example.org"
                  value={issuerInput}
                  onChange={(e) => setIssuerInput(e.target.value)}
                  required
                />
                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={loading === "issuer"}
                >
                  {loading === "issuer" ? (
                    <>
                      <Spinner /> Reading…
                    </>
                  ) : (
                    "Read stellar.toml"
                  )}
                </button>
              </form>

              {issuerError && (
                <div className="info-box info-box--warning">
                  <span className="eyebrow">stellar.toml</span>
                  <p className="muted">{issuerError}</p>
                </div>
              )}

              {issuerResult && (
                <>
                  <div className="info-box">
                    <span className="eyebrow">
                      Published by {issuerResult.homeDomain}
                    </span>
                    <p className="muted">
                      Organisation: {issuerResult.orgName ?? "not published"}
                    </p>
                    {issuerResult.account && (
                      <a
                        className="text-link"
                        href={explorerAccountUrl(issuerResult.account)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Issuer account on explorer ↗
                      </a>
                    )}
                  </div>

                  <div className="subhead">DOCUMENTATION</div>
                  {Object.keys(issuerResult.documentation ?? {}).length > 0 ? (
                    <div className="metadata-grid">
                      {Object.entries(issuerResult.documentation).map(([key, value]) => (
                        <div key={key}>
                          <span className="metadata-label">{key}</span>
                          <span className="metadata-value">{String(value)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No DOCUMENTATION table is published.</p>
                  )}

                  <div className="subhead">Currencies</div>
                  {issuerResult.rows.length > 0 ? (
                    <ul className="balance-list">
                      {issuerResult.rows.map((row, index) => (
                        <li
                          key={`${row.code ?? "unspecified"}-${index}`}
                          className="balance-row"
                        >
                          <div>
                            <strong>{row.code ?? "code not published"}</strong>
                            {row.issuer && (
                              <span className="muted balance-row__issuer">
                                {shortenAddress(row.issuer)}
                              </span>
                            )}
                          </div>
                          <div className="balance-row__actions">
                            <span>
                              display decimals {row.displayDecimals ?? "not published"}
                            </span>
                            {row.issuer && (
                              <a
                                className="text-link"
                                href={explorerAccountUrl(row.issuer)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Explorer ↗
                              </a>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">No CURRENCIES rows are published.</p>
                  )}
                </>
              )}
            </div>
          )}

          {activeTab === "Web auth" && (
            <div className="section">
              <h2>Web authentication</h2>
              <p className="muted">
                Ask an anchor for a sign-in challenge, check it, sign it in Freighter, and show
                what the returned session says. The session lives in this panel only — it is
                never stored.
              </p>

              <form className="form" onSubmit={handleWebAuth}>
                <label className="label" htmlFor="webauth-endpoint">
                  Web-auth endpoint
                </label>
                <input
                  id="webauth-endpoint"
                  className="input"
                  type="text"
                  placeholder="https://auth.example.org/auth"
                  value={webAuthForm.endpoint}
                  onChange={(e) =>
                    setWebAuthForm({ ...webAuthForm, endpoint: e.target.value })
                  }
                  required
                />
                <label className="label" htmlFor="webauth-server-account">
                  Endpoint&apos;s server account
                </label>
                <input
                  id="webauth-server-account"
                  className="input"
                  type="text"
                  placeholder="G…"
                  value={webAuthForm.serverAccount}
                  onChange={(e) =>
                    setWebAuthForm({ ...webAuthForm, serverAccount: e.target.value })
                  }
                  required
                />
                <p className="muted">
                  A challenge whose source account is not this one is refused before anything is
                  signed, and so is one that has already expired.
                </p>
                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={loading === "webauth" || requireWallet}
                >
                  {loading === "webauth" ? (
                    <>
                      <Spinner /> Signing in Freighter…
                    </>
                  ) : (
                    "Request & sign challenge"
                  )}
                </button>
                {requireWallet && <p className="muted">Connect Freighter to sign.</p>}
              </form>

              {webAuthError && (
                <div className="info-box info-box--warning">
                  <span className="eyebrow">Web authentication</span>
                  <p className="muted">{webAuthError}</p>
                </div>
              )}

              {webAuthResult && (
                <div className="info-box" role="status" aria-live="polite">
                  <span className="eyebrow">Signed challenge</span>
                  <div className="metadata-grid">
                    <div>
                      <span className="metadata-label">Server</span>
                      <span className="metadata-value">
                        {shortenAddress(webAuthResult.serverAccount)}
                      </span>
                    </div>
                    <div>
                      <span className="metadata-label">Operation</span>
                      <span className="metadata-value">
                        {webAuthResult.operationName} · {webAuthResult.operationCount}
                      </span>
                    </div>
                    <div>
                      <span className="metadata-label">Valid until</span>
                      <span className="metadata-value">
                        {formatCreatedAt(webAuthResult.expiresAtMs) ?? "—"}
                      </span>
                    </div>
                    <div>
                      <span className="metadata-label">Session subject</span>
                      <span className="metadata-value">
                        {shortenAddress(webAuthResult.session.subject)}
                      </span>
                    </div>
                    <div>
                      <span className="metadata-label">Session expires</span>
                      <span className="metadata-value">
                        {formatCreatedAt(webAuthResult.session.expiresAtMs) ?? "—"}
                      </span>
                    </div>
                  </div>
                  <p className="muted">
                    {webAuthResult.session.expired
                      ? "The session token has already expired."
                      : "The session token is current."}
                  </p>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        <strong>Kitewell</strong> · Stellar {activeNetwork.label} · Freighter ·{" "}
        <a
          href="https://github.com/Kitewell-lab/Kitewell"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </footer>
    </div>
  );
}

function DecodedEnvelope({ decoded }) {
  const networkLabel = decoded.network?.label || decoded.network?.passphrase;
  const transaction = decoded.isFeeBump ? decoded.inner : decoded;

  return (
    <div className="inspect-result">
      <div className="info-box">
        <span className="eyebrow">Decoded on</span>
        <code>{networkLabel || "Selected network"}</code>
      </div>
      {decoded.isFeeBump && (
        <div className="info-box">
          <span className="eyebrow">Fee-bump · fee source</span>
          <code>{decoded.feeSource}</code>
          <p className="muted" style={{ marginTop: 6 }}>
            Outer fee: {decoded.fee} stroops
          </p>
        </div>
      )}
      <div className="subhead">
        {decoded.isFeeBump ? "Inner transaction" : "Transaction"}
      </div>
      <TransactionDetails transaction={transaction} />
    </div>
  );
}

function TransactionDetails({ transaction }) {
  const memo = transaction.memo
    ? `${transaction.memo.type}: ${transaction.memo.value}`
    : "None";
  const timeBounds = transaction.timeBounds
    ? `${transaction.timeBounds.minTime} – ${transaction.timeBounds.maxTime}`
    : "None";

  return (
    <>
      <div className="info-box">
        <div className="metadata-grid">
          <div>
            <span className="metadata-label">Source</span>
            <span className="metadata-value">{transaction.source}</span>
          </div>
          <div>
            <span className="metadata-label">Fee</span>
            <span className="metadata-value">{transaction.fee} stroops</span>
          </div>
          <div>
            <span className="metadata-label">Sequence</span>
            <span className="metadata-value">{transaction.sequence}</span>
          </div>
          <div>
            <span className="metadata-label">Memo</span>
            <span className="metadata-value">{memo}</span>
          </div>
          <div>
            <span className="metadata-label">Time bounds</span>
            <span className="metadata-value">{timeBounds}</span>
          </div>
        </div>
      </div>
      {transaction.operations.map((operation) => (
        <div className="info-box" key={operation.index}>
          <span className="eyebrow">
            Operation {operation.index + 1} · {operation.type}
          </span>
          <div className="metadata-grid">
            {operation.fields.map((field) => (
              <div key={field.key}>
                <span className="metadata-label">{field.label}</span>
                <span className="metadata-value">{field.value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function tabSlug(tab) {
  return tab.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Issue #512: a payment the stream already prepended stays at the top when a
 * manual refresh re-reads it, so the paged rows drop any id the stream showed.
 */
function mergeStreamedPayments(streamed, paged) {
  const streamedIds = new Set(streamed.map((tx) => tx.id));
  return [...streamed, ...paged.filter((tx) => !streamedIds.has(tx.id))];
}

const STREAM_CLOSED_LINES = {
  disconnect: "Payments stream closed: the wallet was disconnected.",
  "network-change": "Payments stream closed: the network changed.",
  "tab-hidden": "Payments stream closed: this tab was left.",
};

/** Issue #512: what the history tab says about its own stream. */
function streamStatusLabel(state) {
  if (!state) return "New payments appear at the top of this list as they arrive.";
  if (state.failure) return state.failure;
  if (state.status === "open") return "Streaming new payments into the top of the list.";
  if (state.status === "closed") {
    return STREAM_CLOSED_LINES[state.reason] ?? "Payments stream closed.";
  }
  return "Payments stream not running.";
}

function formatCreatedAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function KitewellMark() {
  return (
    <svg className="mark" width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden>
      <circle cx="18" cy="18" r="18" fill="#121826" />
      <circle cx="18" cy="18" r="7" fill="#F5C542" />
      <g stroke="#E8A317" strokeWidth="1.6" strokeLinecap="round">
        <path d="M18 3v4M18 29v4M3 18h4M29 18h4" />
        <path d="M7.8 7.8l2.8 2.8M25.4 25.4l2.8 2.8M7.8 28.2l2.8-2.8M25.4 10.6l2.8-2.8" />
      </g>
    </svg>
  );
}

function Spinner({ size = 16 }) {
  return (
    <svg
      className="spinner"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}
