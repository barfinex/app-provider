// import { MarketType, Connector, ConnectorType, Subscription, SubscriptionType } from "@barfinex/types";

// export class GlobalService {
//     static connector: { [key: string]: Connector } = {}
//     // static GlobalService: any;

//     // static getOptions(connectorType: ConnectorType, marketType: MarketType): Connector {
//     //     console.log("GlobalService.connector:", GlobalService.connector);
//     //     return GlobalService.connector[connectorType + marketType]
//     // }

//     // static setOptions(connectorType: ConnectorType, marketType: MarketType, connector: Connector): void {
//     //     GlobalService.connector[connectorType + marketType] = connector
//     // }

//     static addSubscription(connectorType: ConnectorType, marketType: MarketType, subscription: Subscription): void {

//         if (!GlobalService.connector[connectorType + marketType]?.subscriptions) GlobalService.connector[connectorType + marketType].subscriptions = []


//         if (!GlobalService.connector[connectorType + marketType]?.subscriptions?.find(q => q.type === subscription.type && q.symbol === subscription.symbol)) {
//             GlobalService.connector[connectorType + marketType].subscriptions.push(subscription);
//         }
//         else {
//             const filterSubscriptions = GlobalService.connector[connectorType + marketType].subscriptions.filter(({ type, symbol }) => !(type === subscription.type && symbol === subscription.symbol));
//             GlobalService.connector[connectorType + marketType].subscriptions = [...filterSubscriptions]
//             GlobalService.connector[connectorType + marketType].subscriptions.push(subscription);
//         }
//     }

//     // static getSubscription(connectorType: ConnectorType, marketType: MarketType, subscriptionType: SubscriptionType): Subscription {
//     //     return GlobalService.connector[connectorType + marketType].subscriptions.find(q => q.type == subscriptionType)
//     // }

// }

// // export class ConfigConnector {
// //     public connectorType: ConnectorType
// //     public subscribedAssets: { [key: string]: ConfigConnectorAssets } = {}
// //     public updateMomentAccount?: number
// // }

// // export class ConfigConnectorAssets {
// //     public symbol: Symbol
// //     public updateMomentTrade?: number
// //     public updateMomentCandle?: number
// //     public updateMomentOrderbook?: number

// // }

