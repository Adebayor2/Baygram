export const chatTypeDefs = `#graphql
  type Message {
    id: ID!
    conversationId: ID!
    sender: Profile!
    body: String
    media: Media
    createdAt: String!
    deleted: Boolean!
    clientId: String
  }

  type Conversation {
    id: ID!
    isGroup: Boolean!
    title: String
    members: [Profile!]!
    lastMessage: Message
    unreadCount: Int!
    lastMessageAt: String!
  }

  type ConversationPage {
    items: [Conversation!]!
    nextCursor: String
  }

  type MessagePage {
    items: [Message!]!
    nextCursor: String
  }

  input SendMessageInput {
    conversationId: ID!
    body: String
    media: MediaInput
    clientId: String
  }

  extend type Query {
    conversations(first: Int = 20, after: String): ConversationPage!
    conversation(id: ID!): Conversation
    messages(conversationId: ID!, first: Int = 30, after: String): MessagePage!
  }

  extend type Mutation {
    startConversation(username: String!): Conversation!
    createGroup(title: String!, usernames: [String!]!): Conversation!
    sendMessage(input: SendMessageInput!): Message!
    markConversationRead(conversationId: ID!): Boolean!
    deleteMessage(messageId: ID!): Boolean!
  }
`;
