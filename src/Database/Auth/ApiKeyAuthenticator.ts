import {Box, Random, Key} from 'sodium';
import * as BluebirdPromise from 'bluebird';
import * as RequestPromise from 'request-promise';
import {IHeaders} from "../../Http/IHeaders";
import {AuthenticationException} from "../DatabaseExceptions";
import {StringUtil} from "../../Utility/StringUtil";
import {IResponse, IResponseBody} from "../../Http/Response/IResponse";
import {StatusCodes, StatusCode} from "../../Http/Response/StatusCode";
import {TypeUtil} from "../../Utility/TypeUtil";
import {RequestMethods} from "../../Http/Request/RequestMethod";
import {ICipherBox} from "../../Utility/Crypt";
import {IRavenObject} from "../IRavenObject";

export interface IAuthServerRequest {
  payload: object,
  secretKey: Buffer
}

export class ApiKeyAuthenticator {
  private _serverPublicKeys: {
    [url: string]: Buffer
  };

  public authenticate(url: string, apiKey: string, headers: IHeaders): BluebirdPromise<Buffer> {
    if (!apiKey) {
      return BluebirdPromise.reject(new AuthenticationException('Api key is empty')) as BluebirdPromise<Buffer>;
    }

    let name: string, secret: string;
    let publicKey: Buffer, secretKey: Buffer;

    [name, secret] = apiKey.split('/', 2);

    const tryAuthenticate: () => BluebirdPromise<IResponse> = () => this.getServerPublicKey(url)
      .then((receivedKey: Buffer) => {
        const request: IAuthServerRequest = this.buildServerRequest(secret, receivedKey);

        return RequestPromise({
          json: true,
          body: request,
          headers: headers,
          method: RequestMethods.Post,
          url: '/api-key/validate',
          resolveWithFullResponse: true,
          qs: {
            apiKey: name
          }
        })
        .catch(() => BluebirdPromise.reject(new AuthenticationException('Bad response from server')))
        .then((response: IResponse) => {
          const code: StatusCode = response.statusCode;

          if (StatusCodes.isExpectationFailed(code)) {
            delete this._serverPublicKeys[url];

            return tryAuthenticate();
          }

          if (![StatusCodes.Forbidden, StatusCodes.Ok,
              StatusCodes.InternalServerError].includes(code)
          ) {
            return BluebirdPromise.reject(new AuthenticationException('Bad response from server')) as BluebirdPromise<IResponse>;
          }

          secretKey = request.secretKey;
          publicKey = receivedKey;
          return response;
        })
      });

    return tryAuthenticate()
      .then((response: IResponse) => {
        const body: IRavenObject = response.body;

        if (body.Error) {
          return BluebirdPromise.reject(new AuthenticationException(body.Error)) as BluebirdPromise<Buffer>;
        }

        const sodiumBox: Box = new Box(publicKey, secretKey);
        const cipherBox: ICipherBox = {
          cipherText: new Buffer(atob(body.Token)),
          nonce: new Buffer(atob(body.Nonce))
        };

        return sodiumBox.decrypt(cipherBox) as Buffer;
      });
  }

  protected getServerPublicKey(url: string): BluebirdPromise<Buffer> {
    if (url in this._serverPublicKeys) {
      return BluebirdPromise.resolve(this._serverPublicKeys[url]) as BluebirdPromise<Buffer>;
    }

    return RequestPromise({
      json: true,
      method: RequestMethods.Get,
      resolveWithFullResponse: true,
      uri: StringUtil.format('{0}/api-key/public-key')
    })
    .catch(() => BluebirdPromise.reject(new AuthenticationException('Bad response from server')))
    .then((response: IResponse) => {
      let publicKey: Buffer, body: IResponseBody;

      if (!StatusCodes.isOk(response.statusCode)
        && !TypeUtil.isObject(body = response.body as IResponseBody) && !body.PublicKey
      ) {
        return BluebirdPromise.reject(new AuthenticationException(`Bad response from server when \ 
trying to get public key`));
      }

      try {
        publicKey = new Buffer(atob(body.PublicKey));
        this._serverPublicKeys[url] = publicKey;
      } catch (exception) {
        return BluebirdPromise.reject(new AuthenticationException(`Error decoding public key: ${exception.message}`));
      }

      return publicKey;
    }) as BluebirdPromise<Buffer>;
  }

  protected buildServerRequest(secret: string, serverPublicKey: Buffer): IAuthServerRequest {
    const keyPair: Key.Box = new Key.Box();
    const sodiumBox: Box = new Box(serverPublicKey, keyPair.getSecretKey());
    const secretToEncode: string = secret + Random.buffer(64 - (secret.length % 64)).toString();
    const cipherBox: ICipherBox = sodiumBox.encrypt(new Buffer(secretToEncode));

    return {
      secretKey: keyPair.getSecretKey(),
      payload: {
        'Secret'    : btoa(cipherBox.cipherText.toString()),
        'PublicKey' : btoa(keyPair.getPublicKey().toString()),
        'Nonce'     : btoa(cipherBox.nonce.toString()),
        'ServerKey' : btoa(serverPublicKey.toString())
      }
    };
  }
}