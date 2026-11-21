export const profileTypeDefs = `#graphql
  type Profile {
    id: ID!
    username: String!
    fullName: String
    bio: String
    avatarUrl: String
    isPrivate: Boolean!
    createdAt: String!
  }

  extend type Profile {
    followersCount: Int!
    followingCount: Int!
    viewerFollowStatus: ViewerFollowStatus!
    followsViewer: Boolean!
    viewerIsBlocking: Boolean!
  }

  input UpdateProfileInput {
    username: String
    fullName: String
    bio: String
    isPrivate: Boolean
  }

  extend type Query {
    me: Profile
    profile(username: String!): Profile
  }

  extend type Mutation {
    createProfile(username: String!, fullName: String): Profile!
    updateProfile(input: UpdateProfileInput!): Profile!
  }

  type PresenceInfo {
    isOnline: Boolean!
    lastSeenAt: String
  }

  extend type Query {
    presence(username: String!): PresenceInfo!
  }
`;
