import {
    OutboundAccountInfo,
    ExecutionReport,
    AccountUpdate,
    OrderUpdate,
    AccountConfigUpdate,
    MarginCall,
    UserDataStreamEvent,
} from 'binance-api-node';

import {
    Account,
    Asset,
    Position,
    TradeSide,
    MarketType,
    AccountEventHandler,
} from '@barfinex/types';

import { ConnectorService } from '../../../connector.service';

export function createAccountAdapter(context: any) {
    return function accountAdapter(
        marketType: MarketType,
        handler: AccountEventHandler,
    ) {
        return (
            msg:
                | OutboundAccountInfo
                | ExecutionReport
                | AccountUpdate
                | OrderUpdate
                | AccountConfigUpdate
                | MarginCall
                | UserDataStreamEvent,
        ) => {
            let options: any = {};

            if (msg.eventType === 'ACCOUNT_UPDATE') {
                const account: Account = {
                    connectorType: context.connectorType,
                    marketType,
                    assets: [],
                    positions: [],
                    orders: [],
                    isActive: true,
                    symbols: [],
                };

                msg.balances.map((item: any) => {
                    const asset: Asset = {
                        connectorType: context.connectorType,
                        marketType,
                        symbol: { name: item.asset },
                        walletBalance: parseFloat(item.walletBalance),
                        availableBalance: 0,
                    };

                    const index = account.assets.findIndex(
                        (q) => q.symbol?.name === asset.symbol.name,
                    );

                    if (index === -1) account.assets.push(asset);
                    else account.assets[index] = asset;
                });

                msg.positions.map((item: any) => {
                    const position: Position = {
                        connectorType: context.connectorType,
                        marketType,
                        symbol: { name: item.symbol },
                        quantity: parseFloat(item.positionAmount),
                        entryPrice: parseFloat(item.entryPrice),
                        initialMargin: 0,
                        leverage: 0,
                        side:
                            item.positionSide === 'LONG'
                                ? TradeSide.LONG
                                : TradeSide.SHORT,
                    };

                    const IMR = 1 / (position.leverage || 1);
                    position.initialMargin =
                        position.quantity * position.entryPrice * IMR;
                    position.side =
                        position.quantity > 0
                            ? TradeSide.LONG
                            : TradeSide.SHORT;

                    const index = account.positions.findIndex(
                        (q) => q.symbol?.name === position.symbol.name,
                    );

                    if (index === -1) account.positions.push(position);
                    else account.positions[index] = position;

                    if (
                        !account.symbols.find(
                            (q) => q.name === position.symbol.name,
                        )
                    ) {
                        account.symbols.push({ name: position.symbol.name });
                    }

                    ConnectorService.setAccount(account);
                });
            }

            if (msg.eventType === 'ORDER_TRADE_UPDATE') {
                options = {
                    orderId: msg.orderId,
                    orderTime: msg.orderTime,
                    orderType: msg.orderType,
                    orderStatus: msg.orderStatus,
                    clientOrderId: msg.clientOrderId,
                    symbol: msg.symbol,
                    side: msg.side,
                    quantity: msg.quantity,
                };
            }

            handler.call(context, marketType, {
                eventType: msg.eventType,
                eventTime: Number(msg.eventTime),
                options,
            });
        };
    };
}
