export const engagementTypeDefs = `#graphql
  type Comment {
    id: ID!
    post: Post!
    author: Profile!
    body: String!
    parentId: ID
    repliesCount: Int!
    createdAt: String!
  }

  type CommentPage {
    items: [Comment!]!
    nextCursor: String
  }

  extend type Post {
    viewerHasLiked: Boolean!
    viewerHasSaved: Boolean!
    comments(first: Int = 20, after: String): CommentPage!
  }

  extend type Query {
    comments(postId: ID!, first: Int = 20, after: String): CommentPage!
    replies(commentId: ID!, first: Int = 20, after: String): CommentPage!
    likers(postId: ID!, first: Int = 20, after: String): ProfilePage!
    savedPosts(first: Int = 20, after: String): PostPage!
  }

  extend type Mutation {
    likePost(postId: ID!): Post!
    unlikePost(postId: ID!): Post!
    addComment(postId: ID!, body: String!, parentId: ID): Comment!
    deleteComment(commentId: ID!): Boolean!
    savePost(postId: ID!): Post!
    unsavePost(postId: ID!): Post!
  }
`;
