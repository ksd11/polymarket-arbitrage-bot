import { Trade } from "@polymarket/clob-client-v2";

export type OrderTradeExecution = {
    executionId: string;
    shares: number;
    notional: number;
    price: number;
};

function positiveNumber(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function executionsForOrder(trades: Trade[], orderId: string): OrderTradeExecution[] {
    const executions: OrderTradeExecution[] = [];
    for (const trade of trades) {
        if (trade.taker_order_id === orderId) {
            const shares = positiveNumber(trade.size);
            const price = positiveNumber(trade.price);
            if (shares !== undefined && price !== undefined) executions.push({ executionId: `${trade.id}:taker`, shares, price, notional: shares * price });
        }
        for (let index = 0; index < (trade.maker_orders ?? []).length; index += 1) {
            const maker = trade.maker_orders[index];
            if (maker.order_id !== orderId) continue;
            const shares = positiveNumber(maker.matched_amount);
            const price = positiveNumber(maker.price);
            if (shares !== undefined && price !== undefined) executions.push({ executionId: `${trade.id}:maker:${index}`, shares, price, notional: shares * price });
        }
    }
    return executions;
}

export function summarizeOrderExecutions(executions: OrderTradeExecution[]): { shares: number; notional: number; averagePrice?: number; executionIds: string[] } {
    const unique = new Map(executions.map((execution) => [execution.executionId, execution]));
    let shares = 0;
    let notional = 0;
    for (const execution of unique.values()) {
        shares += execution.shares;
        notional += execution.notional;
    }
    return { shares, notional, averagePrice: shares > 0 ? notional / shares : undefined, executionIds: [...unique.keys()] };
}
