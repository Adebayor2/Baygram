export const followTypeDefs = `#graphql
  enum ViewerFollowStatus {
    SELF
    NONE
    REQUESTED
    FOLLOWING
  }

  type ProfilePage {
    items: [Profile!]!
    nextCursor: String
  }

  extend type Query {
    followers(username: String!, first: Int = 20, after: String): ProfilePage!
    following(username: String!, first: Int = 20, after: String): ProfilePage!
    followRequests(first: Int = 20, after: String): ProfilePage!
  }

  extend type Mutation {
    follow(username: String!): Profile!
    unfollow(username: String!): Profile!
    acceptFollowRequest(username: String!): Profile!
    rejectFollowRequest(username: String!): Profile!
    block(username: String!): Profile!
    unblock(username: String!): Profile!
  }
`;
