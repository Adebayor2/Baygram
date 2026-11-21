export const baseTypeDefs = `#graphql
  type Query {
    hello: String!
    visits: Int!
  }

  type Mutation {
    _empty: Boolean
  }
`;
