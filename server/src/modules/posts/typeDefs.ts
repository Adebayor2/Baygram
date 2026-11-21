export const postTypeDefs = `#graphql
  type Post {
    id: ID!
    author: Profile!
    caption: String
    media: [Media!]!
    likesCount: Int!
    commentsCount: Int!
    createdAt: String!
  }

  type PostPage {
    items: [Post!]!
    nextCursor: String
  }

  input CreatePostInput {
    caption: String
    media: [MediaInput!]!
  }

  extend type Profile {
    postsCount: Int!
  }

  extend type Query {
    post(id: ID!): Post
    userPosts(username: String!, first: Int = 20, after: String): PostPage!
    homeFeed(first: Int = 20, after: String): PostPage!
    explore(first: Int = 20, after: String): PostPage!
  }

  extend type Mutation {
    createPost(input: CreatePostInput!): Post!
    updatePostCaption(postId: ID!, caption: String): Post!
    deletePost(postId: ID!): Boolean!
  }
`;
