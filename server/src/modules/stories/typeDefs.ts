export const storyTypeDefs = `#graphql
  type Story {
    id: ID!
    author: Profile!
    media: Media!
    caption: String
    createdAt: String!
    expiresAt: String!
    viewedByViewer: Boolean!
    viewersCount: Int!
  }

  type StoryGroup {
    author: Profile!
    stories: [Story!]!
    hasUnseen: Boolean!
    latestAt: String!
  }

  extend type Query {
    storiesTray: [StoryGroup!]!
    userStories(username: String!): [Story!]!
    storyViewers(storyId: ID!, first: Int = 20, after: String): ProfilePage!
  }

  extend type Mutation {
    createStory(media: MediaInput!, caption: String): Story!
    deleteStory(storyId: ID!): Boolean!
    viewStory(storyId: ID!): Boolean!
  }
`;
