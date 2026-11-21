export const notificationTypeDefs = `#graphql
  enum NotificationType {
    LIKE
    COMMENT
    REPLY
    FOLLOW
    FOLLOW_REQUEST
    FOLLOW_ACCEPTED
    MENTION
    MISSED_CALL
  }

  type Notification {
    id: ID!
    type: NotificationType!
    actor: Profile!
    post: Post
    comment: Comment
    readAt: String
    createdAt: String!
  }

  type NotificationPage {
    items: [Notification!]!
    nextCursor: String
  }

  extend type Query {
    notifications(first: Int = 20, after: String, unreadOnly: Boolean = false): NotificationPage!
    unreadNotificationsCount: Int!
  }

  extend type Mutation {
    markNotificationRead(id: ID!): Boolean!
    markAllNotificationsRead: Boolean!
  }
`;
