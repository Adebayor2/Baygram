import { parse } from "graphql";
import { baseTypeDefs } from "../modules/base/typeDefs.js";
import { baseResolvers } from "../modules/base/resolvers.js";
import { profileTypeDefs } from "../modules/profiles/typeDefs.js";
import { profileResolvers } from "../modules/profiles/resolvers.js";
import { followTypeDefs } from "../modules/follows/typeDefs.js";
import { followResolvers } from "../modules/follows/resolvers.js";
import { mediaTypeDefs } from "../modules/media/typeDefs.js";
import { mediaResolvers } from "../modules/media/resolvers.js";
import { postTypeDefs } from "../modules/posts/typeDefs.js";
import { postResolvers } from "../modules/posts/resolvers.js";
import { engagementTypeDefs } from "../modules/engagement/typeDefs.js";
import { engagementResolvers } from "../modules/engagement/resolvers.js";
import { searchTypeDefs } from "../modules/search/typeDefs.js";
import { searchResolvers } from "../modules/search/resolvers.js";
import { notificationTypeDefs } from "../modules/notifications/typeDefs.js";
import { notificationResolvers } from "../modules/notifications/resolvers.js";
import { chatTypeDefs } from "../modules/chat/typeDefs.js";
import { chatResolvers } from "../modules/chat/resolvers.js";
import { storyTypeDefs } from "../modules/stories/typeDefs.js";
import { storyResolvers } from "../modules/stories/resolvers.js";
import { pushTypeDefs } from "../modules/push/typeDefs.js";
import { pushResolvers } from "../modules/push/resolvers.js";
import { callTypeDefs } from "../modules/calls/typeDefs.js";
import { callResolvers } from "../modules/calls/resolvers.js";

export const typeDefs = [
  baseTypeDefs,
  profileTypeDefs,
  followTypeDefs,
  mediaTypeDefs,
  postTypeDefs,
  engagementTypeDefs,
  searchTypeDefs,
  notificationTypeDefs,
  chatTypeDefs,
  storyTypeDefs,
  pushTypeDefs,
  callTypeDefs,
].map((source) => parse(source));
export const resolvers = [
  baseResolvers,
  profileResolvers,
  followResolvers,
  mediaResolvers,
  postResolvers,
  engagementResolvers,
  searchResolvers,
  notificationResolvers,
  chatResolvers,
  storyResolvers,
  pushResolvers,
  callResolvers,
];
