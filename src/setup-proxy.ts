/**
 * Setup global fetch proxy for Node.js undici-based fetch.
 * Must be imported BEFORE any fetch calls.
 */
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(process.cwd(), ".env") });

const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;

if (proxyUrl) {
    const agent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(agent);
    console.log(`[proxy] Global fetch proxy set to: ${proxyUrl}`);
}
