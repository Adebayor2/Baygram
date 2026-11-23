export const pushTypeDefs = `#graphql
  input PushSubscriptionInput {
    endpoint: String!
    p256dh: String!
    auth: String!
    userAgent: String
  }

  extend type Query {
    vapidPublicKey: String!
  }

  extend type Mutation {
    registerPushSubscription(input: PushSubscriptionInput!): Boolean!
    unregisterPushSubscription(endpoint: String!): Boolean!
  }
`;
