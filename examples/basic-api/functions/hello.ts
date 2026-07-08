import type { APIGatewayProxyHandler } from "aws-lambda";

export const handler: APIGatewayProxyHandler = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Hello from a locally-running Lambda!",
      path: event.path,
      time: new Date().toISOString(),
    }),
  };
};
