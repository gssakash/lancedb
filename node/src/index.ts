// Copyright 2023 Lance Developers.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  RecordBatchFileWriter,
  type Table as ArrowTable,
  tableFromIPC,
  Vector
} from 'apache-arrow'
import { fromRecordsToBuffer } from './arrow'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { databaseNew, databaseTableNames, databaseOpenTable, tableCreate, tableSearch, tableAdd, tableCreateVectorIndex } = require('../native.js')

/**
 * Connect to a LanceDB instance at the given URI
 * @param uri The uri of the database.
 */
export async function connect (uri: string): Promise<Connection> {
  return new Connection(uri)
}

/**
 * A connection to a LanceDB database.
 */
export class Connection {
  private readonly _uri: string
  private readonly _db: any

  constructor (uri: string) {
    this._uri = uri
    this._db = databaseNew(uri)
  }

  get uri (): string {
    return this._uri
  }

  /**
     * Get the names of all tables in the database.
     */
  async tableNames (): Promise<string[]> {
    return databaseTableNames.call(this._db)
  }

  /**
     * Open a table in the database.
     * @param name The name of the table.
     */
  async openTable (name: string): Promise<Table> {
    const tbl = await databaseOpenTable.call(this._db, name)
    return new Table(tbl, name)
  }

  async createTable<T> (name: string, data: Array<Record<string, unknown>>, embeddings?: Embeddings<T>): Promise<Table> {
    await tableCreate.call(this._db, name, await fromRecordsToBuffer(data, embeddings))
    return await this.openTable(name)
  }

  async createTableArrow (name: string, table: ArrowTable): Promise<Table> {
    const writer = RecordBatchFileWriter.writeAll(table)
    await tableCreate.call(this._db, name, Buffer.from(await writer.toUint8Array()))
    return await this.openTable(name)
  }
}

/**
 * A table in a LanceDB database.
 */
export class Table {
  private readonly _tbl: any
  private readonly _name: string

  constructor (tbl: any, name: string) {
    this._tbl = tbl
    this._name = name
  }

  get name (): string {
    return this._name
  }

  /**
    * Creates a search query to find the nearest neighbors of the given query vector.
    * @param queryVector The query vector.
    */
  search (queryVector: number[]): Query
  /**
   * Creates a search query to find the nearest neighbors of the given search term
   * @param query The query search term
   * @param embeddings An embedding function used to vectorize the query vector
   */
  search<T> (query: T, embeddings: Embeddings<T>): Query;
  search<T> (query: T | number[], embeddings?: Embeddings<T>): Query {
    let queryVector: number[]
    if (embeddings !== undefined) {
      queryVector = embeddings.embed([query as T])[0]
    } else {
      queryVector = query as number[]
    }
    return new Query(this._tbl, queryVector)
  }

  /**
   * Insert records into this Table
   * @param data Records to be inserted into the Table
   *
   * @param mode Append / Overwrite existing records. Default: Append
   * @return The number of rows added to the table
   */
  async add<T> (data: Array<Record<string, unknown>>, embeddings?: Embeddings<T>): Promise<number> {
    return tableAdd.call(this._tbl, await fromRecordsToBuffer(data, embeddings), WriteMode.Append.toString())
  }

  async overwrite<T> (data: Array<Record<string, unknown>>, embeddings?: Embeddings<T>): Promise<number> {
    return tableAdd.call(this._tbl, await fromRecordsToBuffer(data, embeddings), WriteMode.Overwrite.toString())
  }

  async create_index (indexParams: VectorIndexParams): Promise<any> {
    return tableCreateVectorIndex.call(this._tbl, indexParams)
  }
}

interface IvfPQIndexConfig {
  /**
   * The column to be indexed
   */
  column?: string

  /**
   * A unique name for the index
   */
  index_name?: string

  /**
   * Metric type, L2 or Cosine
   */
  metric_type?: MetricType

  /**
   * The number of partitions this index
   */
  num_partitions?: number

  /**
   * The max number of iterations for kmeans training.
   */
  max_iters?: number

  /**
   * Train as optimized product quantization.
   */
  use_opq?: boolean

  /**
   * Number of subvectors to build PQ code
   */
  num_sub_vectors?: number
  /**
   * The number of bits to present one PQ centroid.
   */
  num_bits?: number

  /**
   * Max number of iterations to train OPQ, if `use_opq` is true.
   */
  max_opq_iters?: number

  type: 'ivf'
}

export enum MetricType {
  L2 = 'l2',
  Cosine = 'cosine'
}

export type VectorIndexParams = IvfPQIndexConfig

/**
 * A builder for nearest neighbor queries for LanceDB.
 */
export class Query {
  private readonly _tbl: any
  private readonly _query_vector: number[]
  private _limit: number
  private readonly _refine_factor?: number
  private readonly _nprobes: number
  private readonly _columns?: string[]
  private _filter?: string
  private readonly _metric = 'L2'

  constructor (tbl: any, queryVector: number[]) {
    this._tbl = tbl
    this._query_vector = queryVector
    this._limit = 10
    this._nprobes = 20
    this._refine_factor = undefined
    this._columns = undefined
    this._filter = undefined
  }

  limit (value: number): Query {
    this._limit = value
    return this
  }

  filter (value: string): Query {
    this._filter = value
    return this
  }

  /**
     * Execute the query and return the results as an Array of Objects
     */
  async execute<T = Record<string, unknown>> (): Promise<T[]> {
    let buffer
    if (this._filter != null) {
      buffer = await tableSearch.call(this._tbl, this._query_vector, this._limit, this._filter)
    } else {
      buffer = await tableSearch.call(this._tbl, this._query_vector, this._limit)
    }
    const data = tableFromIPC(buffer)
    return data.toArray().map((entry: Record<string, unknown>) => {
      const newObject: Record<string, unknown> = {}
      Object.keys(entry).forEach((key: string) => {
        if (entry[key] instanceof Vector) {
          newObject[key] = (entry[key] as Vector).toArray()
        } else {
          newObject[key] = entry[key]
        }
      })
      return newObject as unknown as T
    })
  }
}

export enum WriteMode {
  Overwrite = 'overwrite',
  Append = 'append'
}

/**
 * An embedding function that automatically creates vector representation for a given column
 */
export interface Embeddings<T> {
  targetColumn: string
  embed: (data: T[]) => number[][]
}
