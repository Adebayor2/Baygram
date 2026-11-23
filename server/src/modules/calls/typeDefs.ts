export const callTypeDefs = `#graphql
  enum CallType {
    AUDIO
    VIDEO
  }

  enum CallStatus {
    MISSED
    REJECTED
    CANCELED
    COMPLETED
    FAILED
  }

  type CallLog {
    id: ID!
    caller: Profile!
    callee: Profile!
    type: CallType!
    status: CallStatus!
    startedAt: String!
    durationSec: Int
    direction: String!
  }

  type CallLogPage {
    items: [CallLog!]!
    nextCursor: String
  }

  type IceServer {
    urls: [String!]!
    username: String
    credential: String
  }

  extend type Query {
    callHistory(first: Int = 20, after: String): CallLogPage!
    iceServers: [IceServer!]!
  }
`;
