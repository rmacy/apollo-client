import { ExecutionResult, DocumentNode } from 'graphql';
import { invariant, InvariantError } from 'ts-invariant';

import { ApolloLink } from '../link/core/ApolloLink';
import { execute } from '../link/core/execute';
import { FetchResult } from '../link/core/types';
import { Cache } from '../cache/core/types/Cache';

import {
  getDefaultValues,
  getOperationDefinition,
  getOperationName,
} from '../utilities/graphql/getFromAST';
import {
  hasClientExports,
} from '../utilities/graphql/directives';
import {
  graphQLResultHasError,
  tryFunctionOrLogError,
} from '../utilities/common/errorHandling';
import { removeConnectionDirectiveFromDocument } from '../utilities/graphql/transform';
import { canUseWeakMap } from '../utilities/common/canUse';
import { ApolloError, isApolloError } from '../errors/ApolloError';
import {
  ObservableSubscription,
  Observable,
} from '../utilities/observables/Observable';
import { MutationStore } from '../data/mutations';
import {
  QueryOptions,
  WatchQueryOptions,
  SubscriptionOptions,
  MutationOptions,
  WatchQueryFetchPolicy,
} from './watchQueryOptions';
import { ObservableQuery } from './ObservableQuery';
import { NetworkStatus, isNetworkRequestInFlight } from './networkStatus';
import {
  QueryListener,
  ApolloQueryResult,
  OperationVariables,
  MutationQueryReducer,
} from './types';
import { LocalState } from './LocalState';
import {
  Concast,
  asyncMap,
  multicast,
} from '../utilities/observables/observables';
import { isNonEmptyArray } from '../utilities/common/arrays';
import { ApolloCache } from '../cache/core/cache';

import { QueryInfo, QueryStoreValue } from './QueryInfo';

const { hasOwnProperty } = Object.prototype;

type QueryWithUpdater = {
  updater: MutationQueryReducer<Object>;
  queryInfo: QueryInfo;
};

export class QueryManager<TStore> {
  public cache: ApolloCache<TStore>;
  public link: ApolloLink;
  public mutationStore: MutationStore = new MutationStore();
  public readonly assumeImmutableResults: boolean;
  public readonly ssrMode: boolean;

  private queryDeduplication: boolean;
  private clientAwareness: Record<string, string> = {};
  private localState: LocalState<TStore>;

  private onBroadcast: () => void;

  // All the queries that the QueryManager is currently managing (not
  // including mutations and subscriptions).
  private queries = new Map<string, QueryInfo>();

  // Maps from queryId strings to Promise rejection functions for
  // currently active queries and fetches.
  private queryCancelFns = new Map<string, (error: any) => any>();
  private fetchCancelFns = new Map<string, (error: any) => any>();

  constructor({
    cache,
    link,
    queryDeduplication = false,
    onBroadcast = () => undefined,
    ssrMode = false,
    clientAwareness = {},
    localState,
    assumeImmutableResults,
  }: {
    cache: ApolloCache<TStore>;
    link: ApolloLink;
    queryDeduplication?: boolean;
    onBroadcast?: () => void;
    ssrMode?: boolean;
    clientAwareness?: Record<string, string>;
    localState?: LocalState<TStore>;
    assumeImmutableResults?: boolean;
  }) {
    this.cache = cache;
    this.link = link;
    this.queryDeduplication = queryDeduplication;
    this.onBroadcast = onBroadcast;
    this.clientAwareness = clientAwareness;
    this.localState = localState || new LocalState({ cache });
    this.ssrMode = ssrMode;
    this.assumeImmutableResults = !!assumeImmutableResults;
  }

  /**
   * Call this method to terminate any active query processes, making it safe
   * to dispose of this QueryManager instance.
   */
  public stop() {
    this.queries.forEach((_info, queryId) => {
      this.stopQueryNoBroadcast(queryId);
    });

    this.cancelPendingFetches(
      new InvariantError('QueryManager stopped while query was in flight'),
    );
  }

  private cancelPendingFetches(error: Error) {
    this.queryCancelFns.forEach(cancel => cancel(error));
    this.fetchCancelFns.forEach(cancel => cancel(error));
    this.queryCancelFns.clear();
    this.fetchCancelFns.clear();
  }

  public async mutate<T>({
    mutation,
    variables,
    optimisticResponse,
    updateQueries: updateQueriesByName,
    refetchQueries = [],
    awaitRefetchQueries = false,
    update: updateWithProxyFn,
    errorPolicy = 'none',
    fetchPolicy,
    context = {},
  }: MutationOptions): Promise<FetchResult<T>> {
    invariant(
      mutation,
      'mutation option is required. You must specify your GraphQL document in the mutation option.',
    );

    invariant(
      !fetchPolicy || fetchPolicy === 'no-cache',
      "Mutations only support a 'no-cache' fetchPolicy. If you don't want to disable the cache, remove your fetchPolicy setting to proceed with the default mutation behavior."
    );

    const mutationId = this.generateMutationId();
    mutation = this.transform(mutation).document;

    variables = this.getVariables(mutation, variables);

    if (this.transform(mutation).hasClientExports) {
      variables = await this.localState.addExportedVariables(mutation, variables, context);
    }

    // Create a map of update queries by id to the query instead of by name.
    const generateUpdateQueriesInfo: () => {
      [queryId: string]: QueryWithUpdater;
    } = () => {
      const ret: { [queryId: string]: QueryWithUpdater } = {};

      if (updateQueriesByName) {
        this.queries.forEach(({ observableQuery }, queryId) => {
          if (observableQuery &&
              observableQuery.watching) {
            const { queryName } = observableQuery;
            if (
              queryName &&
              hasOwnProperty.call(updateQueriesByName, queryName)
            ) {
              ret[queryId] = {
                updater: updateQueriesByName[queryName],
                queryInfo: this.queries.get(queryId)!,
              };
            }
          }
        });
      }

      return ret;
    };

    this.mutationStore.initMutation(
      mutationId,
      mutation,
      variables,
    );

    if (optimisticResponse) {
      const optimistic = typeof optimisticResponse === 'function'
        ? optimisticResponse(variables)
        : optimisticResponse;

      this.cache.recordOptimisticTransaction(cache => {
        markMutationResult({
          mutationId: mutationId,
          result: { data: optimistic },
          document: mutation,
          variables: variables,
          queryUpdatersById: generateUpdateQueriesInfo(),
          update: updateWithProxyFn,
        }, cache);
      }, mutationId);
    }

    this.broadcastQueries();

    const self = this;

    return new Promise((resolve, reject) => {
      let storeResult: FetchResult<T> | null;
      let error: ApolloError;

      self.getObservableFromLink(
        mutation,
        {
          ...context,
          optimisticResponse,
        },
        variables,
        false,
      ).subscribe({
        next(result: ExecutionResult) {
          if (graphQLResultHasError(result) && errorPolicy === 'none') {
            error = new ApolloError({
              graphQLErrors: result.errors,
            });
            return;
          }

          self.mutationStore.markMutationResult(mutationId);

          if (fetchPolicy !== 'no-cache') {
            try {
              markMutationResult({
                mutationId,
                result,
                document: mutation,
                variables,
                queryUpdatersById: generateUpdateQueriesInfo(),
                update: updateWithProxyFn,
              }, self.cache);
            } catch (e) {
              error = new ApolloError({
                networkError: e,
              });
              return;
            }
          }

          storeResult = result as FetchResult<T>;
        },

        error(err: Error) {
          self.mutationStore.markMutationError(mutationId, err);
          if (optimisticResponse) {
            self.cache.removeOptimistic(mutationId);
          }
          self.broadcastQueries();
          reject(
            new ApolloError({
              networkError: err,
            }),
          );
        },

        complete() {
          if (error) {
            self.mutationStore.markMutationError(mutationId, error);
          }

          if (optimisticResponse) {
            self.cache.removeOptimistic(mutationId);
          }

          self.broadcastQueries();

          if (error) {
            reject(error);
            return;
          }

          // allow for conditional refetches
          // XXX do we want to make this the only API one day?
          if (typeof refetchQueries === 'function') {
            refetchQueries = refetchQueries(storeResult as ExecutionResult);
          }

          const refetchQueryPromises: Promise<
            ApolloQueryResult<any>[] | ApolloQueryResult<{}>
          >[] = [];

          if (isNonEmptyArray(refetchQueries)) {
            refetchQueries.forEach(refetchQuery => {
              if (typeof refetchQuery === 'string') {
                self.queries.forEach(({ observableQuery }) => {
                  if (observableQuery &&
                      observableQuery.watching &&
                      observableQuery.queryName === refetchQuery) {
                    refetchQueryPromises.push(observableQuery.refetch());
                  }
                });
              } else {
                const queryOptions: QueryOptions = {
                  query: refetchQuery.query,
                  variables: refetchQuery.variables,
                  fetchPolicy: 'network-only',
                };

                if (refetchQuery.context) {
                  queryOptions.context = refetchQuery.context;
                }

                refetchQueryPromises.push(self.query(queryOptions));
              }
            });
          }

          Promise.all(
            awaitRefetchQueries ? refetchQueryPromises : [],
          ).then(() => {
            if (
              errorPolicy === 'ignore' &&
              storeResult &&
              graphQLResultHasError(storeResult)
            ) {
              delete storeResult.errors;
            }

            resolve(storeResult!);
          });
        },
      });
    });
  }

  public fetchQuery<TData, TVars>(
    queryId: string,
    options: WatchQueryOptions<TVars>,
    networkStatus?: NetworkStatus,
  ): Promise<ApolloQueryResult<TData>> {
    return this.fetchQueryObservable<TData, TVars>(
      queryId,
      options,
      networkStatus,
    ).promise;
  }

  public getQueryStore() {
    const store: Record<string, QueryStoreValue> = Object.create(null);
    this.queries.forEach((info, queryId) => {
      store[queryId] = {
        variables: info.variables,
        networkStatus: info.networkStatus,
        networkError: info.networkError,
        graphQLErrors: info.graphQLErrors,
      };
    });
    return store;
  }

  public getQueryStoreValue(queryId: string): QueryStoreValue | undefined {
    return queryId ? this.queries.get(queryId) : undefined;
  }

  private transformCache = new (canUseWeakMap ? WeakMap : Map)<
    DocumentNode,
    Readonly<{
      document: Readonly<DocumentNode>;
      hasClientExports: boolean;
      hasForcedResolvers: boolean;
      clientQuery: Readonly<DocumentNode> | null;
      serverQuery: Readonly<DocumentNode> | null;
      defaultVars: Readonly<OperationVariables>;
    }>
  >();

  public transform(document: DocumentNode) {
    const { transformCache } = this;

    if (!transformCache.has(document)) {
      const transformed = this.cache.transformDocument(document);
      const forLink = removeConnectionDirectiveFromDocument(
        this.cache.transformForLink(transformed));

      const clientQuery = this.localState.clientQuery(transformed);
      const serverQuery = forLink && this.localState.serverQuery(forLink);

      const cacheEntry = {
        document: transformed,
        // TODO These two calls (hasClientExports and shouldForceResolvers)
        // could probably be merged into a single traversal.
        hasClientExports: hasClientExports(transformed),
        hasForcedResolvers: this.localState.shouldForceResolvers(transformed),
        clientQuery,
        serverQuery,
        defaultVars: getDefaultValues(
          getOperationDefinition(transformed)
        ) as OperationVariables,
      };

      const add = (doc: DocumentNode | null) => {
        if (doc && !transformCache.has(doc)) {
          transformCache.set(doc, cacheEntry);
        }
      }
      // Add cacheEntry to the transformCache using several different keys,
      // since any one of these documents could end up getting passed to the
      // transform method again in the future.
      add(document);
      add(transformed);
      add(clientQuery);
      add(serverQuery);
    }

    return transformCache.get(document)!;
  }

  private getVariables(
    document: DocumentNode,
    variables?: OperationVariables,
  ): OperationVariables {
    return {
      ...this.transform(document).defaultVars,
      ...variables,
    };
  }

  // The shouldSubscribe option is a temporary fix that tells us whether watchQuery was called
  // directly (i.e. through ApolloClient) or through the query method within QueryManager.
  // Currently, the query method uses watchQuery in order to handle non-network errors correctly
  // but we don't want to keep track observables issued for the query method since those aren't
  // supposed to be refetched in the event of a store reset. Once we unify error handling for
  // network errors and non-network errors, the shouldSubscribe option will go away.

  public watchQuery<T, TVariables = OperationVariables>(
    options: WatchQueryOptions<TVariables>,
    shouldSubscribe = true,
  ): ObservableQuery<T, TVariables> {
    // assign variable default values if supplied
    options = {
      ...options,
      variables: this.getVariables(
        options.query,
        options.variables,
      ) as TVariables,
    };

    if (typeof options.notifyOnNetworkStatusChange === 'undefined') {
      options.notifyOnNetworkStatusChange = false;
    }

    const observable = new ObservableQuery<T, TVariables>({
      queryManager: this,
      options,
      shouldSubscribe: shouldSubscribe,
    });

    this.getQuery(observable.queryId).init({
      document: options.query,
      observableQuery: observable,
      variables: options.variables,
    });

    return observable;
  }

  public query<T>(options: QueryOptions): Promise<ApolloQueryResult<T>> {
    invariant(
      options.query,
      'query option is required. You must specify your GraphQL document ' +
        'in the query option.',
    );

    invariant(
      options.query.kind === 'Document',
      'You must wrap the query string in a "gql" tag.',
    );

    invariant(
      !(options as any).returnPartialData,
      'returnPartialData option only supported on watchQuery.',
    );

    invariant(
      !(options as any).pollInterval,
      'pollInterval option only supported on watchQuery.',
    );

    return new Promise<ApolloQueryResult<T>>((resolve, reject) => {
      const watchedQuery = this.watchQuery<T>(options, false);
      const { queryId } = watchedQuery;
      this.queryCancelFns.set(queryId, reject);
      watchedQuery
        .result()
        .then(resolve, reject)
        // Since neither resolve nor reject throw or return a value, this .then
        // handler is guaranteed to execute. Note that it doesn't really matter
        // when we remove the reject function from this.fetchCancelFns,
        // since resolve and reject are mutually idempotent. In fact, it would
        // not be incorrect to let reject functions accumulate over time; it's
        // just a waste of memory.
        .then(() => this.queryCancelFns.delete(queryId));
    });
  }

  private queryIdCounter = 1;
  public generateQueryId() {
    return String(this.queryIdCounter++);
  }

  private requestIdCounter = 1;
  public generateRequestId() {
    return this.requestIdCounter++;
  }

  private mutationIdCounter = 1;
  public generateMutationId() {
    return String(this.mutationIdCounter++);
  }

  public stopQueryInStore(queryId: string) {
    this.stopQueryInStoreNoBroadcast(queryId);
    this.broadcastQueries();
  }

  private stopQueryInStoreNoBroadcast(queryId: string) {
    const queryInfo = this.queries.get(queryId);
    if (queryInfo) queryInfo.stop();
  }

  public addQueryListener(queryId: string, listener: QueryListener) {
    this.getQuery(queryId).listeners.add(listener);
  }

  public clearStore(): Promise<void> {
    // Before we have sent the reset action to the store, we can no longer
    // rely on the results returned by in-flight requests since these may
    // depend on values that previously existed in the data portion of the
    // store. So, we cancel the promises and observers that we have issued
    // so far and not yet resolved (in the case of queries).
    this.cancelPendingFetches(new InvariantError(
      'Store reset while query was in flight (not completed in link chain)',
    ));

    this.queries.forEach(queryInfo => {
      if (queryInfo.observableQuery &&
          queryInfo.observableQuery.watching) {
        // Set loading to true so listeners don't trigger unless they want
        // results with partial data.
        queryInfo.networkStatus = NetworkStatus.loading;
      } else {
        queryInfo.stop();
      }
    });

    this.mutationStore.reset();

    // begin removing data from the store
    return this.cache.reset();
  }

  public resetStore(): Promise<ApolloQueryResult<any>[]> {
    // Similarly, we have to have to refetch each of the queries currently being
    // observed. We refetch instead of error'ing on these since the assumption is that
    // resetting the store doesn't eliminate the need for the queries currently being
    // watched. If there is an existing query in flight when the store is reset,
    // the promise for it will be rejected and its results will not be written to the
    // store.
    return this.clearStore().then(() => {
      return this.reFetchObservableQueries();
    });
  }

  public reFetchObservableQueries(
    includeStandby: boolean = false,
  ): Promise<ApolloQueryResult<any>[]> {
    const observableQueryPromises: Promise<ApolloQueryResult<any>>[] = [];

    this.queries.forEach(({ observableQuery }, queryId) => {
      if (observableQuery &&
          observableQuery.watching) {
        const fetchPolicy = observableQuery.options.fetchPolicy;

        observableQuery.resetLastResults();
        if (
          fetchPolicy !== 'cache-only' &&
          (includeStandby || fetchPolicy !== 'standby')
        ) {
          observableQueryPromises.push(observableQuery.refetch());
        }

        this.getQuery(queryId).setDiff(null);
      }
    });

    this.broadcastQueries();

    return Promise.all(observableQueryPromises);
  }

  public observeQuery(observableQuery: ObservableQuery<any>) {
    const { queryId, options } = observableQuery;

    this.getQuery(queryId).setObservableQuery(observableQuery);

    // These mutableOptions can be updated whenever the function we are
    // about to return gets called, or inside the fetchQueryObservable
    // method, which sometimes alters mutableOptions.fetchPolicy.
    let mutableOptions: WatchQueryOptions<any> = { ...options };

    return <TData, TVars>(
      newOptions?: Partial<WatchQueryOptions<TVars>>,
      newNetworkStatus?: NetworkStatus,
    ): Concast<ApolloQueryResult<TData>> => {
      // TODO Would this be necessary if we never deleted QueryInfo
      // objects from this.queries?
      this.getQuery(queryId).setObservableQuery(observableQuery);

      if (newOptions) {
        Object.keys(newOptions).forEach(key => {
          const value = (newOptions as any)[key];
          if (value !== void 0) {
            (mutableOptions as any)[key] = value;
          }
        });
      }

      return this.fetchQueryObservable<TData, TVars>(
        queryId,
        mutableOptions,
        newNetworkStatus,
      );
    };
  }

  public startGraphQLSubscription<T = any>({
    query,
    fetchPolicy,
    variables,
  }: SubscriptionOptions): Observable<FetchResult<T>> {
    query = this.transform(query).document;
    variables = this.getVariables(query, variables);

    const makeObservable = (variables: OperationVariables) =>
      this.getObservableFromLink<T>(
        query,
        {},
        variables,
        false,
      ).map(result => {
        if (!fetchPolicy || fetchPolicy !== 'no-cache') {
          // the subscription interface should handle not sending us results we no longer subscribe to.
          // XXX I don't think we ever send in an object with errors, but we might in the future...
          if (!graphQLResultHasError(result)) {
            this.cache.write({
              query,
              result: result.data,
              dataId: 'ROOT_SUBSCRIPTION',
              variables: variables,
            });
          }

          this.broadcastQueries();
        }

        if (graphQLResultHasError(result)) {
          throw new ApolloError({
            graphQLErrors: result.errors,
          });
        }

        return result;
      });

    if (this.transform(query).hasClientExports) {
      const observablePromise = this.localState.addExportedVariables(
        query,
        variables,
      ).then(makeObservable);

      return new Observable<FetchResult<T>>(observer => {
        let sub: ObservableSubscription | null = null;
        observablePromise.then(
          observable => sub = observable.subscribe(observer),
          observer.error,
        );
        return () => sub && sub.unsubscribe();
      });
    }

    return makeObservable(variables);
  }

  public stopQuery(queryId: string) {
    this.stopQueryNoBroadcast(queryId);
    this.broadcastQueries();
  }

  private stopQueryNoBroadcast(queryId: string) {
    this.stopQueryInStoreNoBroadcast(queryId);
    this.removeQuery(queryId);
  }

  public removeQuery(queryId: string) {
    // teardown all links
    // Both `QueryManager.fetchRequest` and `QueryManager.query` create separate promises
    // that each add their reject functions to fetchCancelFns.
    // A query created with `QueryManager.query()` could trigger a `QueryManager.fetchRequest`.
    // The same queryId could have two rejection fns for two promises
    this.queryCancelFns.delete(queryId);
    this.fetchCancelFns.delete(queryId);
    this.getQuery(queryId).subscriptions.forEach(x => x.unsubscribe());
    this.queries.delete(queryId);
  }

  public getCurrentQueryResult<T>(
    observableQuery: ObservableQuery<T>,
    optimistic: boolean = true,
  ): {
    data: T | undefined;
    partial: boolean;
  } {
    const { variables, query, fetchPolicy, returnPartialData } = observableQuery.options;
    const lastResult = observableQuery.getLastResult();

    if (fetchPolicy === 'no-cache' ||
        fetchPolicy === 'network-only') {
      const diff = this.getQuery(observableQuery.queryId).getDiff();
      return { data: diff?.result, partial: false };
    }

    const { result, complete } = this.cache.diff<T>({
      query,
      variables,
      previousResult: lastResult ? lastResult.data : undefined,
      returnPartialData: true,
      optimistic,
    });

    return {
      data: (complete || returnPartialData) ? result : void 0,
      partial: !complete,
    };
  }

  public getQueryWithPreviousResult<TData, TVariables = OperationVariables>(
    queryIdOrObservable: string | ObservableQuery<TData, TVariables>,
  ): {
    previousResult: any;
    variables: TVariables | undefined;
    document: DocumentNode;
  } {
    let observableQuery: ObservableQuery<TData, any>;
    if (typeof queryIdOrObservable === 'string') {
      const { observableQuery: foundObservableQuery } = this.getQuery(
        queryIdOrObservable,
      );
      invariant(
        foundObservableQuery,
        `ObservableQuery with this id doesn't exist: ${queryIdOrObservable}`
      );
      observableQuery = foundObservableQuery!;
    } else {
      observableQuery = queryIdOrObservable;
    }

    const { variables, query } = observableQuery.options;
    return {
      previousResult: this.getCurrentQueryResult(observableQuery, false).data,
      variables,
      document: query,
    };
  }

  public broadcastQueries() {
    this.onBroadcast();
    this.queries.forEach(info => info.notify());
  }

  public getLocalState(): LocalState<TStore> {
    return this.localState;
  }

  private inFlightLinkObservables = new Map<
    DocumentNode,
    Map<string, Observable<FetchResult>>
  >();

  private getObservableFromLink<T = any>(
    query: DocumentNode,
    context: any,
    variables?: OperationVariables,
    deduplication: boolean = this.queryDeduplication,
  ): Observable<FetchResult<T>> {
    let observable: Observable<FetchResult<T>>;

    const { serverQuery } = this.transform(query);
    if (serverQuery) {
      const { inFlightLinkObservables, link } = this;

      const operation = {
        query: serverQuery,
        variables,
        operationName: getOperationName(serverQuery) || void 0,
        context: this.prepareContext({
          ...context,
          forceFetch: !deduplication
        }),
      };

      context = operation.context;

      if (deduplication) {
        const byVariables = inFlightLinkObservables.get(serverQuery) || new Map();
        inFlightLinkObservables.set(serverQuery, byVariables);

        const varJson = JSON.stringify(variables);
        observable = byVariables.get(varJson);

        if (!observable) {
          const cc = multicast(
            execute(link, operation) as Observable<FetchResult<T>>
          );

          byVariables.set(varJson, observable = cc);

          cc.cleanup(() => {
            if (byVariables.delete(varJson) &&
                byVariables.size < 1) {
              inFlightLinkObservables.delete(serverQuery);
            }
          });
        }

      } else {
        observable = multicast(execute(link, operation) as Observable<FetchResult<T>>);
      }
    } else {
      observable = multicast(Observable.of({ data: {} } as FetchResult<T>));
      context = this.prepareContext(context);
    }

    const { clientQuery } = this.transform(query);
    if (clientQuery) {
      observable = asyncMap(observable, result => {
        return this.localState.runResolvers({
          document: clientQuery,
          remoteResult: result,
          context,
          variables,
        });
      });
    }

    return observable;
  }

  private fetchQueryObservable<TData, TVariables>(
    queryId: string,
    mutableOptions: WatchQueryOptions<TVariables>,
    // The initial networkStatus for this fetch, most often
    // NetworkStatus.loading, but also possibly fetchMore, poll, refetch,
    // or setVariables.
    networkStatus = NetworkStatus.loading,
  ): Concast<ApolloQueryResult<TData>> {
    const query = this.transform(mutableOptions.query).document;
    const variables = this.getVariables(query, mutableOptions.variables);
    const {
      context = {},
      errorPolicy = "none",
      returnPartialData = false,
    } = mutableOptions;

    const requestId = this.generateRequestId();
    const queryInfo = this.getQuery(queryId);
    const lastNetworkStatus = queryInfo.networkStatus;

    queryInfo.init({
      document: query,
      variables,
      lastRequestId: requestId,
      networkStatus,
    }).updateWatch(mutableOptions);

    let fetchPolicy: WatchQueryFetchPolicy =
      mutableOptions.fetchPolicy || "cache-first";

    const mightUseNetwork =
      fetchPolicy === "cache-first" ||
      fetchPolicy === "cache-and-network" ||
      fetchPolicy === "network-only" ||
      fetchPolicy === "no-cache";

    let shouldNotify = false;
    if (mightUseNetwork &&
        isNetworkRequestInFlight(networkStatus) &&
        typeof lastNetworkStatus === "number" &&
        lastNetworkStatus !== networkStatus &&
        mutableOptions.notifyOnNetworkStatusChange) {
      if (fetchPolicy !== "cache-first") {
        fetchPolicy = "cache-and-network";
      }
      shouldNotify = true;
    }

    const readFromCache = () => this.cache.diff<any>({
      query,
      variables,
      returnPartialData: true,
      optimistic: true,
    });

    const readFromLink = (
      allowCacheWrite: boolean,
    ): Observable<ApolloQueryResult<TData>> => asyncMap(
      // TODO Move this asyncMap logic into getObservableFromLink?
      this.getObservableFromLink(query, context, variables),

      result => {
        const hasErrors = isNonEmptyArray(result.errors);

        if (requestId >= queryInfo.lastRequestId) {
          if (hasErrors && errorPolicy === "none") {
            // Throwing here effectively calls observer.error.
            throw queryInfo.markError(new ApolloError({
              graphQLErrors: result.errors,
            }));
          }

          queryInfo.markResult(result, {
            variables,
            fetchPolicy,
            errorPolicy,
          }, allowCacheWrite);

          queryInfo.markReady();
        }

        const aqr: ApolloQueryResult<TData> = {
          data: result.data,
          loading: false,
          networkStatus: queryInfo.networkStatus || NetworkStatus.ready,
        };

        if (hasErrors && errorPolicy !== "ignore") {
          aqr.errors = result.errors;
        }

        return aqr;
      },

      networkError => {
        const error = isApolloError(networkError)
          ? networkError
          : new ApolloError({ networkError });

        if (requestId >= queryInfo.lastRequestId) {
          queryInfo.markError(error);
        }

        throw error;
      },
    );

    const finish = (...obs: Observable<ApolloQueryResult<TData>>[]) => {
      const cc = new Concast(obs);
      this.fetchCancelFns.set(queryId, reason => {
        Promise.resolve().then(() => cc.cancel(reason));
      });
      cc.cleanup(() => this.fetchCancelFns.delete(queryId));
      return cc;
    };

    switch (fetchPolicy) {
    case "cache-first": {
      const diff = readFromCache();

      if (diff.complete) {
        return finish(
          Observable.of({
            data: diff.result,
            loading: false,
            networkStatus: queryInfo.markReady(),
          }),
        );
      }

      if (returnPartialData || shouldNotify) {
        return finish(
          Observable.of({
            data: diff.result,
            errors: diff.missing as any[],
            loading: true,
            networkStatus: queryInfo.networkStatus || NetworkStatus.loading,
          }),
          readFromLink(true),
        );
      }

      return finish(readFromLink(true));
    }

    case "cache-and-network": {
      const diff = readFromCache();

      if (mutableOptions.fetchPolicy === "cache-and-network") {
        mutableOptions.fetchPolicy = "cache-first";
      }

      if (diff.complete || returnPartialData || shouldNotify) {
        return finish(
          Observable.of({
            data: diff.result,
            loading: true,
            networkStatus: queryInfo.networkStatus || NetworkStatus.loading,
          }),
          readFromLink(true),
        );
      }

      return finish(readFromLink(true));
    }

    case "cache-only": {
      const diff = readFromCache();

      return finish(
        Observable.of({
          data: diff.result,
          // TODO Is this abuse of the type system justified?
          errors: diff.missing as any[],
          loading: false,
          networkStatus: queryInfo.markReady(),
        }),
      );
    }

    case "network-only":
      return finish(readFromLink(true));

    case "no-cache":
      return finish(readFromLink(false));

    case "standby":
      return finish();
    }
  }

  private getQuery(queryId: string): QueryInfo {
    if (queryId && !this.queries.has(queryId)) {
      this.queries.set(queryId, new QueryInfo(this.cache));
    }
    return this.queries.get(queryId)!;
  }

  private prepareContext(context = {}) {
    const newContext = this.localState.prepareContext(context);
    return {
      ...newContext,
      clientAwareness: this.clientAwareness,
    };
  }

  public checkInFlight(queryId: string): boolean {
    const query = this.getQueryStoreValue(queryId);
    return (
      !!query &&
      !!query.networkStatus &&
      query.networkStatus !== NetworkStatus.ready &&
      query.networkStatus !== NetworkStatus.error
    );
  }
}

function markMutationResult<TStore>(
  mutation: {
    mutationId: string;
    result: ExecutionResult;
    document: DocumentNode;
    variables: any;
    queryUpdatersById: Record<string, QueryWithUpdater>;
    update:
      ((cache: ApolloCache<TStore>, mutationResult: Object) => void) |
      undefined;
  },
  cache: ApolloCache<TStore>,
) {
  // Incorporate the result from this mutation into the store
  if (!graphQLResultHasError(mutation.result)) {
    const cacheWrites: Cache.WriteOptions[] = [{
      result: mutation.result.data,
      dataId: 'ROOT_MUTATION',
      query: mutation.document,
      variables: mutation.variables,
    }];

    const { queryUpdatersById } = mutation;
    if (queryUpdatersById) {
      Object.keys(queryUpdatersById).forEach(id => {
        const {
          updater,
          queryInfo: {
            document,
            variables,
          },
        }= queryUpdatersById[id];

        // Read the current query result from the store.
        const { result: currentQueryResult, complete } = cache.diff({
          query: document!,
          variables,
          returnPartialData: true,
          optimistic: false,
        });

        if (complete) {
          // Run our reducer using the current query result and the mutation result.
          const nextQueryResult = tryFunctionOrLogError(
            () => updater(currentQueryResult, {
              mutationResult: mutation.result,
              queryName: getOperationName(document!) || undefined,
              queryVariables: variables!,
            }),
          );

          // Write the modified result back into the store if we got a new result.
          if (nextQueryResult) {
            cacheWrites.push({
              result: nextQueryResult,
              dataId: 'ROOT_QUERY',
              query: document!,
              variables,
            });
          }
        }
      });
    }

    cache.performTransaction(c => {
      cacheWrites.forEach(write => c.write(write));

      // If the mutation has some writes associated with it then we need to
      // apply those writes to the store by running this reducer again with a
      // write action.
      const { update } = mutation;
      if (update) {
        tryFunctionOrLogError(() => update(c, mutation.result));
      }
    });
  }
}
