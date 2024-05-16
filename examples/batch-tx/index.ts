import { Cell, Indexer, RPC, Script, config, hd, BI, Hash, Transaction } from "@ckb-lumos/lumos";
import { common } from "@ckb-lumos/lumos/common-scripts";
import {
  encodeToAddress,
  sealTransaction,
  TransactionSkeleton,
  TransactionSkeletonType,
} from "@ckb-lumos/lumos/helpers";
import { JSONStorage } from "node-localstorage";

const SENDER_PRIVATE_KEY = "0x";
const TX_COUNT = 1000;
const URL = "https://testnet.ckb.dev";
const CONFIG = config.TESTNET;

config.initializeConfig(CONFIG);
const SENDER_SCRIPT: Script = {
  codeHash: CONFIG.SCRIPTS.SECP256K1_BLAKE160.CODE_HASH,
  hashType: CONFIG.SCRIPTS.SECP256K1_BLAKE160.HASH_TYPE,
  args: hd.key.privateKeyToBlake160(SENDER_PRIVATE_KEY),
};
const SENDER_ADDRESS = encodeToAddress(SENDER_SCRIPT);

const ONE_CKB = 10n ** 8n;

const rpc = new RPC(URL);
const indexer = new Indexer(URL);
const storage = new JSONStorage("./db");

function printInfo() {
  console.log("sender", SENDER_ADDRESS);
}

// pre-generate random keys
async function step01_mergeUtxo(): Promise<void> {
  const collector = indexer.collector({ lock: SENDER_SCRIPT });

  const neededCkb = 62n * ONE_CKB * BigInt(TX_COUNT);

  let collectedCkb = 0n;
  let cycleTime = 0;
  const cells: Cell[] = [];
  for await (const item of collector.collect()) {
    collectedCkb += BigInt(item.cellOutput.capacity);
    cycleTime++;
    cells.push(item);

    if (collectedCkb >= neededCkb) break;
    if (cycleTime > 100) throw new Error("Not enough capacity");
  }

  if (collectedCkb < neededCkb) throw new Error("Not enough capacity");

  const txSkeleton = TransactionSkeleton().asMutable();
  for (const item of cells) {
    await common.setupInputCell(txSkeleton, item, undefined);
  }

  const mergedCell: Cell = {
    cellOutput: { lock: SENDER_SCRIPT, capacity: BI.from(collectedCkb).toHexString() },
    data: "0x",
  };
  txSkeleton.update("outputs", (outputs) => outputs.clear().push(mergedCell));

  const txHash = await sendTransaction(txSkeleton);
  console.log("merge utxo", txHash);

  mergedCell.outPoint = { txHash, index: "0x0" };
  storage.setItem("offerCell", mergedCell);
  console.log("please wait for the confirmation of", txHash);
}

async function step02_split(): Promise<void> {
  const chunk = 500;
  storage.setItem("splitCells", []);

  for (let i = 0; i < TX_COUNT; i += chunk) {
    const txSkeleton = TransactionSkeleton().asMutable();

    const offerCell: Cell = storage.getItem("offerCell");
    await common.setupInputCell(txSkeleton, offerCell);

    const changeCapacity = BI.from(offerCell.cellOutput.capacity).sub(62n * ONE_CKB * BigInt(chunk));
    const deductedOfferCell: Cell = {
      cellOutput: {
        lock: SENDER_SCRIPT,
        capacity: changeCapacity.toHexString(),
      },
      data: "0x",
    };

    const splitCell: Cell = {
      cellOutput: { capacity: BI.from(62n * ONE_CKB).toHexString(), lock: SENDER_SCRIPT },
      data: "0x",
    };
    const splitCells: Cell[] = Array.from({ length: chunk }).map(() => JSON.parse(JSON.stringify(splitCell)));
    txSkeleton.update("outputs", (outputs) => outputs.set(0, deductedOfferCell).push(...splitCells));

    const txHash = await sendTransaction(txSkeleton);
    console.log("split cell tx", `(${(i / chunk) * 100}%)`, txHash);

    deductedOfferCell.outPoint = { txHash, index: "0x0" };
    deductedOfferCell.cellOutput.capacity = BI.from(deductedOfferCell.cellOutput.capacity).sub(ONE_CKB).toHexString();
    storage.setItem("offerCell", deductedOfferCell);

    splitCells.forEach((cell, index) => {
      cell.outPoint = { txHash, index: BI.from(index + 1).toHexString() };
    });
    storage.setItem("splitCells", (storage.getItem("splitCells") || ([] as Cell[])).concat(splitCells));
  }
}

async function step03_batchSendTransaction() {
  const cells: Cell[] = storage.getItem("splitCells");

  let queue: Transaction[] = [];

  for (let i = 0; i < cells.length; i++) {
    const txSkeleton = TransactionSkeleton().asMutable();
    await common.setupInputCell(txSkeleton, cells[i]);
    queue.push(await payAndSignTransaction(txSkeleton));

    if (queue.length >= 400) {
      await rpc.createBatchRequest(queue.map((tx) => ["sendTransaction", tx])).exec();
      console.log("progress", (i / cells.length) * 100);
      queue = [];
    }
  }

  if (queue.length) {
    await rpc.createBatchRequest(queue.map((tx) => ["sendTransaction", tx])).exec();
    console.log("progress", 100);
  }
}

async function payAndSignTransaction(txSkeleton: TransactionSkeletonType, feeRate = 2000) {
  txSkeleton = txSkeleton.set("cellProvider", indexer);
  txSkeleton = await common.payFeeByFeeRate(txSkeleton, [SENDER_ADDRESS], feeRate);
  txSkeleton = common.prepareSigningEntries(txSkeleton);

  const signatures = txSkeleton
    .get("signingEntries")
    .map((entry) => hd.key.signRecoverable(entry.message, SENDER_PRIVATE_KEY))
    .toArray();

  return sealTransaction(txSkeleton, signatures);
}

async function sendTransaction(txSkeleton: TransactionSkeletonType, feeRate = 2000): Promise<Hash> {
  return rpc.sendTransaction(await payAndSignTransaction(txSkeleton, feeRate));
}

async function main(): Promise<void> {
  printInfo();
  // await step01_mergeUtxo();
  // await step02_split();
  // await step03_batchSendTransaction();
}

main();
