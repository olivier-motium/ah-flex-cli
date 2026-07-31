export const MEMBER_QUERY = `query member {
  member {
    analytics {
      digimon
      __typename
    }
    __typename
  }
}`;

export function createMemberRequestBody() {
  return {
    operationName: "member",
    query: MEMBER_QUERY,
    variables: {},
  };
}
