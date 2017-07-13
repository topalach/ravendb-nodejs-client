// NodeSTatus - keep timer ids, pass update callback from executor
// update node & topology
// add cluster executor - use it for operaitons
// cancel refresh times after topology update
// check concurrency mode determination

import * as BluebirdPromise from 'bluebird';
import * as RequestPromise from 'request-promise';
import {ServerNode} from '../ServerNode';
import {RavenCommand, RavenCommandRequestOptions} from '../../Database/RavenCommand';
import {DocumentConventions} from '../../Documents/Conventions/DocumentConventions';
import {IRavenResponse} from "../../Database/RavenCommandResponse";
import {Topology} from "../Topology";
import {TypeUtil} from "../../Utility/TypeUtil";
import {IHeaders} from "../IHeaders";
import {ApiKeyAuthenticator} from "../../Database/Auth/ApiKeyAuthenticator";
import {IRavenObject} from "../../Database/IRavenObject";
import {Lock} from "../../Lock/Lock";
import {ILockDoneCallback} from "../../Lock/LockCallbacks";
import {GetTopologyCommand} from "../../Database/Commands/GetTopologyCommand";
import {StringUtil} from "../../Utility/StringUtil";
import {DateUtil} from "../../Utility/DateUtil";
import {IResponse, IErrorResponse} from "../Response/IResponse";
import {StatusCodes, StatusCode} from "../Response/StatusCode";
import {Observable} from "../../Utility/Observable";
import {NodeSelector} from "./NodeSelector";
import {RavenException, InvalidOperationException, BadRequestException, AuthorizationException, TopologyNodeDownException, AllTopologyNodesDownException} from "../../Database/DatabaseExceptions";

export interface ITopologyUpdateEvent {
  topologyJson: object;
  serverNodeUrl: string;
  requestedDatabase?: string;
  forceUpdate?: boolean;
  wasUpdated?: boolean;
}

export class RequestExecutor extends Observable {
  public static readonly REQUEST_FAILED      = 'request:failed';
  public static readonly TOPOLOGY_UPDATED    = 'topology:updated';
  public static readonly NODE_STATUS_UPDATED = 'node:status:updated';

  protected conventions?: DocumentConventions;
  protected headers: IHeaders;
  private _lock: Lock;
  private _authenticator: ApiKeyAuthenticator;
  private _apiKey?: string = null;
  private _unauthorizedHandlerInitialized: boolean = false;
  private _firstTopologyUpdateCompleted: boolean = false;
  private _disableTopologyUpdates: boolean;
  private _nodeSelector: NodeSelector;
  private _initialUrls: string[];
  private _initialDatabase: string;

  public get initialDatabase(): string {
    return this._initialDatabase;
  }

  constructor(urls: string[], database: string, apiKey?: string, conventions?: DocumentConventions) {
    super();

    this.headers = {
      "Accept": "application/json",
      "Has-Api-key": TypeUtil.isNone(apiKey) ? 'false' : 'true',
      "Raven-Client-Version": "4.0.0.0",
    };

    this._apiKey = apiKey;
    this._initialUrls = urls;
    this._initialDatabase = database;
    this.conventions = conventions;
    this._lock = Lock.make();
    this._disableTopologyUpdates = urls.length < 2;
    this._authenticator = new ApiKeyAuthenticator();
    this._nodeSelector = new NodeSelector(this, urls, database, apiKey);

    this.updateReplicationTopology();
  }

  public execute(command: RavenCommand): BluebirdPromise<IRavenResponse | IRavenResponse[] | void> {
    const chosenNode: ServerNode = this._nodeSelector.currentNode;

    return this.awaitForTopology()
      .then(() => this.executeCommand(command, chosenNode))
      .catch((exception: RavenException) => {
        if (exception instanceof TopologyNodeDownException) {
          return this.fallbackToNextNode(command, chosenNode);
        }

        return BluebirdPromise.reject(exception);
      });
  }

  protected awaitForTopology(): BluebirdPromise<void> {
    return this._firstTopologyUpdateCompleted 
      ? BluebirdPromise.resolve() : BluebirdPromise.delay(100)
      .then(() => this.awaitForTopology());
  }

  protected prepareCommand(command: RavenCommand, node: ServerNode): RavenCommandRequestOptions {
    let options: RavenCommandRequestOptions;

    command.createRequest(node);
    options = command.toRequestOptions();
    Object.assign(options.headers, this.headers);

    if (!TypeUtil.isNone(node.currentToken)) {
      options.headers['Raven-Authorization'] = node.currentToken;
    }

    if (!this._disableTopologyUpdates) {
      options.headers["Topology-Etag"] = this._nodeSelector.topologyEtag;
    }

    return options;
  }

  protected executeCommand(command: RavenCommand, node: ServerNode): BluebirdPromise<IRavenResponse | IRavenResponse[] | void> {
    let requestOptions: RavenCommandRequestOptions;
    const startTime: number = DateUtil.timestampMs();

    if (!(command instanceof RavenCommand)) {
      return BluebirdPromise.reject(new InvalidOperationException('Not a valid command'));
    }

    try {
      requestOptions = this.prepareCommand(command, node);
    } catch (exception) {
      return BluebirdPromise.reject(exception);
    }

    return RequestPromise(requestOptions)
      .finally(() => {
        node.responseTime = DateUtil.timestampMs() - startTime;
      })
      .catch((errorResponse: IErrorResponse) => {
        if (errorResponse.response) {
          return BluebirdPromise.resolve(errorResponse.response);
        }

        return BluebirdPromise.reject(new TopologyNodeDownException(`Node ${node.url} is down`));
      })
      .then((response: IResponse): BluebirdPromise<IRavenResponse | IRavenResponse[] | void> | (IRavenResponse | IRavenResponse[] | void) => {
        let commandResponse: IRavenResponse | IRavenResponse[] | void = null;
        const code: StatusCode = response.statusCode;
        const isServerError: boolean = [
          StatusCodes.RequestTimeout,
          StatusCodes.BadGateway,
          StatusCodes.GatewayTimeout,
          StatusCodes.ServiceUnavailable
        ].includes(code);

        if (isServerError || StatusCodes.isNotFound(code)) {
          delete response.body;
        } else {
          if (isServerError) {
            return BluebirdPromise.reject(new TopologyNodeDownException(`Node ${node.url} is down`));
          }

          if (StatusCodes.isForbidden(code)) {
            return BluebirdPromise.reject(new AuthorizationException(
              StringUtil.format(
                'Forbidden access to {url}. Make sure you\'re using the correct api-key.',
                node
              )
            ));
          }
        }

        if (!this._disableTopologyUpdates && ("Refresh-Topology" in response.headers)) {
          this.updateReplicationTopology();
        }

        try {
          commandResponse = command.setResponse(response);
        } catch (exception) {
          return BluebirdPromise.reject(exception);
        }

        return commandResponse;
      });
  }

  protected fallbackToNextNode(command: RavenCommand, failedNode: ServerNode): BluebirdPromise<IRavenResponse | IRavenResponse[] | void> {
    let nextNode: ServerNode;
    const nodeSelector: NodeSelector = this._nodeSelector;
    const {REQUEST_FAILED} = <typeof RequestExecutor>this.constructor;

    command.addFailedNode(failedNode);
    this.emit<ServerNode>(REQUEST_FAILED, failedNode);
    setTimeout(this.updateFailingNodeStatus(failedNode), 5 * 1000);

    if (!(nextNode = nodeSelector.currentNode) || command.isFailedWithNode(nextNode)) {
      return BluebirdPromise.reject(new AllTopologyNodesDownException(
        'Tried all nodes in the cluster but failed getting a response'
      ));
    }

    return this.executeCommand(command, nextNode);
  }

  protected updateReplicationTopology(): void {
    const {TOPOLOGY_UPDATED} = <typeof RequestExecutor>this.constructor;

    BluebirdPromise.some(this._initialUrls.map((url: string): PromiseLike<void> => {
      const node = new ServerNode(url, this._initialDatabase);

      return this._lock.acquire((): PromiseLike<void> =>
        this.executeCommand(new GetTopologyCommand(), node)
          .then((response?: IRavenResponse) => {
            let eventData: ITopologyUpdateEvent = {
              topologyJson: response,
              serverNodeUrl: node.url,
              requestedDatabase: node.database,
              forceUpdate: false
            };

            this.emit<ITopologyUpdateEvent>(TOPOLOGY_UPDATED, eventData);
            //TODO: read wasUpdated
        })          
      )
    }), 1)
    .then(() => {
      if (!this._firstTopologyUpdateCompleted) {
        this._firstTopologyUpdateCompleted = true;
      }      
    })
    .finally(() => setTimeout(
      () => this.updateReplicationTopology(), 60 * 5 * 1000
    ));    
  }

  protected updateFailingNodeStatus(node: ServerNode): void {
    const {NODE_STATUS_UPDATED} = <typeof RequestExecutor>this.constructor;
    const command: GetTopologyCommand = new GetTopologyCommand();
    const startTime: number = DateUtil.timestampMs();
    let isStillFailed: boolean = true;

    this._lock.acquireNodeStatus(node.url, node.database, (): PromiseLike<void> => 
      RequestPromise(this.prepareCommand(command, node))
        .then((response: IResponse) => {
          if (StatusCodes.isOk(response.statusCode)) {
            isStillFailed = false;
            this.emit<ServerNode>(NODE_STATUS_UPDATED, node);
          }
        })
        .finally(() => {
          node.reponseTime = DateUtil.timestampMs() - startTime;

          if (isStillFailed) {
            setTimeout(this.updateFailingNodeStatus(node), 5 * 1000);
          }
        })
    );
  }
}