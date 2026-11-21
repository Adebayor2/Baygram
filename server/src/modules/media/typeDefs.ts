export const mediaTypeDefs = `#graphql
  enum MediaKind {
    AVATAR
    POST_IMAGE
    POST_VIDEO
    STORY_IMAGE
    STORY_VIDEO
    MESSAGE_IMAGE
  }

  enum MediaType {
    IMAGE
    VIDEO
  }

  input MediaInput {
    publicId: String!
    type: MediaType!
  }

  type Media {
    publicId: String!
    url: String!
    type: MediaType!
    width: Int
    height: Int
    durationSec: Float
  }

  type UploadSignature {
    cloudName: String!
    apiKey: String!
    timestamp: Int!
    folder: String!
    signature: String!
    resourceType: String!
    uploadUrl: String!
  }

  extend type Mutation {
    createUploadSignature(kind: MediaKind!): UploadSignature!
    setAvatar(publicId: String!): Profile!
    removeAvatar: Profile!
  }
`;
