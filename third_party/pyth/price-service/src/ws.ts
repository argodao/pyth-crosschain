import { HexString } from "@pythnetwork/pyth-sdk-js";
import * as http from "http";
import Joi from "joi";
import WebSocket, { RawData, WebSocketServer } from "ws";
import { PriceInfo, PriceStore } from "./listen";
import { logger } from "./logging";
import { PromClient } from "./promClient";

const ClientMessageSchema: Joi.Schema = Joi.object({
  type: Joi.string().valid("subscribe", "unsubscribe").required(),
  ids: Joi.array()
    .items(Joi.string().regex(/^(0x)?[a-f0-9]{64}$/))
    .required(),
  verbose: Joi.boolean(),
}).required();

export type ClientMessage = {
  type: "subscribe" | "unsubscribe";
  ids: HexString[];
  verbose?: boolean;
};

export type ServerResponse = {
  type: "response";
  status: "success" | "error";
  error?: string;
};

export type ServerPriceUpdate = {
  type: "price_update";
  price_feed: any;
};

export type ServerMessage = ServerResponse | ServerPriceUpdate;

export class WebSocketAPI {
  private wsCounter: number;
  private priceFeedClients: Map<HexString, Set<WebSocket>>;
  private priceFeedClientsVerbosity: Map<HexString, Map<WebSocket, boolean>>;
  private aliveClients: Set<WebSocket>;
  private wsId: Map<WebSocket, number>;
  private priceFeedVaaInfo: PriceStore;
  private promClient: PromClient | undefined;

  constructor(priceFeedVaaInfo: PriceStore, promClient?: PromClient) {
    this.priceFeedVaaInfo = priceFeedVaaInfo;
    this.priceFeedClients = new Map();
    this.priceFeedClientsVerbosity = new Map();
    this.aliveClients = new Set();
    this.wsCounter = 0;
    this.wsId = new Map();
    this.promClient = promClient;
  }

  private addPriceFeedClient(
    ws: WebSocket,
    id: HexString,
    verbose: boolean = false
  ) {
    if (!this.priceFeedClients.has(id)) {
      this.priceFeedClients.set(id, new Set());
      this.priceFeedClientsVerbosity.set(id, new Map([[ws, verbose]]));
    } else {
      this.priceFeedClientsVerbosity.get(id)!.set(ws, verbose);
    }
    this.priceFeedClients.get(id)!.add(ws);
  }

  private delPriceFeedClient(ws: WebSocket, id: HexString) {
    if (!this.priceFeedClients.has(id)) {
      return;
    }
    this.priceFeedClients.get(id)!.delete(ws);
    this.priceFeedClientsVerbosity.get(id)!.delete(ws);
  }

  dispatchPriceFeedUpdate(priceInfo: PriceInfo) {
    if (this.priceFeedClients.get(priceInfo.priceFeed.id) === undefined) {
      logger.info(
        `Sending ${priceInfo.priceFeed.id} price update to no clients.`
      );
      return;
    }

    const clients: Set<WebSocket> = this.priceFeedClients.get(
      priceInfo.priceFeed.id
    )!;
    logger.info(
      `Sending ${priceInfo.priceFeed.id} price update to ${
        clients.size
      } clients: ${Array.from(clients.values()).map((ws, _idx, _arr) =>
        this.wsId.get(ws)
      )}`
    );

    for (const client of clients.values()) {
      this.promClient?.addWebSocketInteraction("server_update", "ok");

      const verbose = this.priceFeedClientsVerbosity
        .get(priceInfo.priceFeed.id)!
        .get(client);

      const priceUpdate: ServerPriceUpdate = verbose
        ? {
            type: "price_update",
            price_feed: {
              ...priceInfo.priceFeed.toJson(),
              metadata: {
                emitter_chain: priceInfo.emitterChainId,
                attestation_time: priceInfo.attestationTime,
                sequence_number: priceInfo.seqNum,
              },
            },
          }
        : {
            type: "price_update",
            price_feed: priceInfo.priceFeed.toJson(),
          };

      client.send(JSON.stringify(priceUpdate));
    }
  }

  clientClose(ws: WebSocket) {
    for (const clients of this.priceFeedClients.values()) {
      if (clients.has(ws)) {
        clients.delete(ws);
      }
    }

    this.aliveClients.delete(ws);
    this.wsId.delete(ws);
  }

  handleMessage(ws: WebSocket, data: RawData) {
    try {
      const jsonData = JSON.parse(data.toString());
      const validationResult = ClientMessageSchema.validate(jsonData);
      if (validationResult.error !== undefined) {
        throw validationResult.error;
      }

      const message = jsonData as ClientMessage;

      message.ids = message.ids.map((id) => {
        if (id.startsWith("0x")) {
          return id.substring(2);
        }
        return id;
      });

      const availableIds = this.priceFeedVaaInfo.getPriceIds();
      const notFoundIds = message.ids.filter((id) => !availableIds.has(id));

      if (notFoundIds.length > 0) {
        throw new Error(
          `Price Feeds with ids ${notFoundIds.join(", ")} not found`
        );
      }

      if (message.type === "subscribe") {
        message.ids.forEach((id) =>
          this.addPriceFeedClient(ws, id, message.verbose === true)
        );
      } else {
        message.ids.forEach((id) => this.delPriceFeedClient(ws, id));
      }
    } catch (e: any) {
      const errorResponse: ServerResponse = {
        type: "response",
        status: "error",
        error: e.message,
      };

      logger.info(
        `Invalid request ${data.toString()} from client ${this.wsId.get(ws)}`
      );
      this.promClient?.addWebSocketInteraction("client_message", "err");

      ws.send(JSON.stringify(errorResponse));
      return;
    }

    logger.info(
      `Successful request ${data.toString()} from client ${this.wsId.get(ws)}`
    );
    this.promClient?.addWebSocketInteraction("client_message", "ok");

    const response: ServerResponse = {
      type: "response",
      status: "success",
    };

    ws.send(JSON.stringify(response));
  }

  run(server: http.Server): WebSocketServer {
    const wss = new WebSocketServer({ server, path: "/ws" });

    wss.on("connection", (ws: WebSocket, request: http.IncomingMessage) => {
      logger.info(
        `Incoming ws connection from ${request.socket.remoteAddress}, assigned id: ${this.wsCounter}`
      );

      this.wsId.set(ws, this.wsCounter);
      this.wsCounter += 1;

      ws.on("message", (data: RawData) => this.handleMessage(ws, data));

      this.aliveClients.add(ws);

      ws.on("pong", (_data) => {
        this.aliveClients.add(ws);
      });

      ws.on("close", (_code: number, _reason: Buffer) => {
        logger.info(`client ${this.wsId.get(ws)} closed the connection.`);
        this.promClient?.addWebSocketInteraction("close", "ok");

        this.clientClose(ws);
      });

      this.promClient?.addWebSocketInteraction("connection", "ok");
    });

    const pingInterval = setInterval(() => {
      wss.clients.forEach((ws) => {
        if (this.aliveClients.has(ws) === false) {
          logger.info(
            `client ${this.wsId.get(ws)} timed out. terminating connection`
          );
          this.promClient?.addWebSocketInteraction("timeout", "ok");
          this.clientClose(ws);
          ws.terminate();
          return;
        }

        this.aliveClients.delete(ws);
        ws.ping();
      });
    }, 30000);

    wss.on("close", () => {
      clearInterval(pingInterval);
    });

    this.priceFeedVaaInfo.addUpdateListener(
      this.dispatchPriceFeedUpdate.bind(this)
    );

    return wss;
  }
}
