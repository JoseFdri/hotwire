import { auth, iot, mqtt5 } from "aws-iot-device-sdk-v2";

export interface ConnectOptions {
  /** AWS IoT Core data-plane endpoint, e.g. `xxxx-ats.iot.us-east-1.amazonaws.com`. */
  endpoint: string;
  region?: string;
  clientId?: string;
}

export type MessageHandler = (payload: Buffer, topic: string) => void;

export interface LiveTransport {
  publish(topic: string, payload: Buffer): Promise<void>;
  subscribe(topicFilter: string, onMessage: MessageHandler): Promise<void>;
  unsubscribe(topicFilter: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Connects to AWS IoT Core over MQTT5-over-websockets using SigV4 auth from the ambient AWS
 * credential chain. Used identically by the deployed stub (Lambda execution role) and the local
 * CLI (developer's local credentials), so the two sides can't drift.
 */
export async function connectIot(options: ConnectOptions): Promise<LiveTransport> {
  const configBuilder = iot.AwsIotMqtt5ClientConfigBuilder.newWebsocketMqttBuilderWithSigv4Auth(
    options.endpoint,
    {
      credentialsProvider: auth.AwsCredentialsProvider.newDefault(),
      region: options.region,
    },
  );
  if (options.clientId) {
    configBuilder.withConnectProperties({ clientId: options.clientId, keepAliveIntervalSeconds: 60 });
  }

  const client = new mqtt5.Mqtt5Client(configBuilder.build());
  const handlers = new Map<string, MessageHandler>();

  client.on("messageReceived", (event) => {
    const topic = event.message.topicName;
    const payload = event.message.payload;
    if (!payload) return;
    for (const [filter, handler] of handlers) {
      if (topicMatches(filter, topic)) {
        handler(Buffer.from(payload as ArrayBuffer), topic);
      }
    }
  });

  const connected = new Promise<void>((resolve, reject) => {
    client.on("connectionSuccess", () => resolve());
    client.on("connectionFailure", (event) => reject(event.error));
  });
  client.start();
  await connected;

  return {
    async publish(topic, payload) {
      await client.publish({
        topicName: topic,
        payload,
        qos: mqtt5.QoS.AtLeastOnce,
      });
    },
    async subscribe(topicFilter, onMessage) {
      handlers.set(topicFilter, onMessage);
      await client.subscribe({
        subscriptions: [{ topicFilter, qos: mqtt5.QoS.AtLeastOnce }],
      });
    },
    async unsubscribe(topicFilter) {
      handlers.delete(topicFilter);
      await client.unsubscribe({ topicFilters: [topicFilter] });
    },
    async close() {
      const stopped = new Promise<void>((resolve) => client.on("stopped", () => resolve()));
      client.stop();
      await stopped;
    },
  };
}

/** Matches an MQTT topic against a subscription filter, supporting `+` and trailing `#`. */
export function topicMatches(filter: string, topic: string): boolean {
  const filterParts = filter.split("/");
  const topicParts = topic.split("/");
  for (let i = 0; i < filterParts.length; i++) {
    const f = filterParts[i];
    if (f === "#") return true;
    if (f === "+") {
      if (i >= topicParts.length) return false;
      continue;
    }
    if (topicParts[i] !== f) return false;
  }
  return filterParts.length === topicParts.length;
}
