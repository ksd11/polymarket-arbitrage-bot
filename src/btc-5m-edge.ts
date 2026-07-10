// Setup global fetch proxy FIRST (before any other imports that might call fetch)
import "./setup-proxy";

import { logger } from "./utils/logger";

function main(): void {
    logger.info("BTC 5m edge strategy is defined for backtesting only right now.");
    logger.info("Use: npm run backtest:btc5m -- --strategy btc5m:edge --csv <path>");
    logger.info("It requires btc_price/open_price data and has not been wired to live order placement yet.");
    process.exit(1);
}

main();
