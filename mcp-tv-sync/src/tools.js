'use strict';
const {
  buildArgs, buildReadArgs, buildAddArgs, buildRemoveArgs, WATCHLISTS,
} = require('./buildArgs.js');

const WL_REQUIRED = { type: 'string', enum: WATCHLISTS, description: 'Which watchlist to operate on.' };
const SYMBOLS = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  description: 'Ticker symbols, e.g. ["NVDA","TSLA"] or exchange-qualified ["TASE:TDRN"].',
};

const TOOL_DEFINITIONS = [
  {
    name: 'tv_sync',
    description:
      'Sync Smart Volume Radar watchlists to TradingView via the repo\'s `npm run tv-sync`. ' +
      'Identical to a manual run. Use dryRun to preview the add/remove diff without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: 'Read + diff only, no writes (--dry-run).', default: false },
        replace: { type: 'boolean', description: 'Remove any TV symbol not in the target list (--replace).', default: false },
        headed: { type: 'boolean', description: 'Visible browser window for debugging (--headed).', default: false },
        watchlist: { type: 'string', enum: WATCHLISTS, description: 'Sync only this one list instead of all four.' },
        file: { type: 'string', description: 'Custom target symbol file (--file); pairs with watchlist.' },
        pruneAfterDays: { type: 'integer', minimum: 0, description: 'Override the staleness window in days (--prune-after-days; default 14).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tv_read_watchlist',
    description: 'Read the current symbols in one TradingView watchlist (read-only, no writes).',
    inputSchema: {
      type: 'object',
      properties: { watchlist: WL_REQUIRED },
      required: ['watchlist'],
      additionalProperties: false,
    },
  },
  {
    name: 'tv_add_symbols',
    description: 'Add specific symbols to one TradingView watchlist (creates the list if missing).',
    inputSchema: {
      type: 'object',
      properties: { watchlist: WL_REQUIRED, symbols: SYMBOLS },
      required: ['watchlist', 'symbols'],
      additionalProperties: false,
    },
  },
  {
    name: 'tv_remove_symbols',
    description: 'Remove specific symbols from one TradingView watchlist.',
    inputSchema: {
      type: 'object',
      properties: { watchlist: WL_REQUIRED, symbols: SYMBOLS },
      required: ['watchlist', 'symbols'],
      additionalProperties: false,
    },
  },
];

// name -> how to build its flags and whether it returns a JSON granular result.
const TOOL_SPECS = {
  tv_sync: { build: buildArgs, granular: false },
  tv_read_watchlist: { build: buildReadArgs, granular: true },
  tv_add_symbols: { build: buildAddArgs, granular: true },
  tv_remove_symbols: { build: buildRemoveArgs, granular: true },
};

module.exports = { TOOL_DEFINITIONS, TOOL_SPECS };
