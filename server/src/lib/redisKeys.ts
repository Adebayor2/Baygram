export const redisKeys = {
  statsVisits: "stats:visits",
  profileCache: (username: string) => `cache:profile:${username}`,
  feedCache: (userId: string, first: number) =>
    `cache:feed:${userId}:${first}`,
  searchUsers: (query: string) =>
    `cache:search:users:${query.trim().toLowerCase()}`,
  searchTags: (query: string) =>
    `cache:search:tags:${query.trim().toLowerCase()}`,
  presenceConnection: (userId: string) => `presence:conn:${userId}`,
  presenceLastSeen: (userId: string) => `presence:lastseen:${userId}`,
  chatUnread: (userId: string) => `chat:unread:${userId}`,
};
