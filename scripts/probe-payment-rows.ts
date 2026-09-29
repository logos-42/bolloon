import * as NP from '../src/agents/network-pulse.js';
import { readTransferIndex, readTransferWatchConfig } from '../src/agents/chain/transfer-index.js';

const cfg = readTransferWatchConfig(undefined);
const state = readTransferIndex(undefined);
console.log('cfg.enabled=', cfg.enabled, 'escrow=', cfg.escrowAddress, 'own=', cfg.ownAddresses, 'watch=', cfg.watchAddresses, 'decimals=', cfg.tokenDecimals);
console.log('entries=', state.entries.length, 'tokenSymbol=', state.tokenSymbol, 'watch=', state.watchAddresses);
const rows = NP.buildPaymentRowsFromTransfers(state.entries as any, {
  headBlock: state.headBlock, chainId: state.chainId, limit: 25,
  watchAddresses: state.watchAddresses, ownAddresses: cfg.ownAddresses,
  escrowAddress: cfg.escrowAddress, tokenSymbol: state.tokenSymbol, tokenDecimals: state.tokenDecimals,
  x402Txs: { '0x8d06bc84888ffcb09b47811aab3776c9ef601b454ab79ae62455f436836e0ff1': {} },
});
console.log('rows=', rows.length);
console.log(JSON.stringify(rows, null, 1).slice(0, 2600));
