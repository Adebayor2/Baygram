export const searchTypeDefs = `#graphql
  type Hashtag {
    name: String!
    postsCount: Int!
  }

  extend type Post {
    hashtags: [String!]!
    mentions: [Profile!]!
  }

  extend type Query {
    searchUsers(query: String!, first: Int = 20, after: String): ProfilePage!
    searchHashtags(query: String!, first: Int = 10): [Hashtag!]!
    hashtag(name: String!): Hashtag
    hashtagPosts(name: String!, first: Int = 20, after: String): PostPage!
  }
`;
