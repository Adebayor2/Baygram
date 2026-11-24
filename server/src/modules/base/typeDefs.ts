export const baseTypeDefs = `#graphql
  type Query {
    hello: String!
    visits: Int!
    _forceError: Boolean
  }

  type Mutation {
    _empty: Boolean
  }
`;
