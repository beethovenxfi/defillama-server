import { Redis } from "ioredis";
import postgres from "postgres";
import { DbEntry } from "./src/adapters/utils/dbInterfaces";
import getTVLOfRecordClosestToTimestamp from "./src/utils/shared/getRecordClosestToTimestamp";
import { getCurrentUnixTimestamp } from "./src/utils/date";

const read: boolean = true;
const pgColumns: string[] = ["key", "timestamp", "price", "confidence"];
const pgConnectionString: string = "";
const latency = 1 * 60 * 60; // 1hr

type Coin = {
  price: number;
  timestamp: number;
  key: string;
  adapter: string;
  confidence: number;
  decimals?: number;
  symbol: string;
};
type CoinDict = {
  [key: string]: Coin;
};
export async function translateItems(
  items: AWS.DynamoDB.DocumentClient.PutItemInputAttributeMap[],
): Promise<Coin[]> {
  const remapped: Coin[] = [];
  const errors: string[] = [];
  const redirects: { [redirect: string]: any } = {};
  items.map((i) => {
    if (i.SK != 0) return;

    const {
      price,
      timestamp,
      PK: key,
      adapter,
      confidence,
      decimals,
      symbol,
      redirect,
    } = i;

    if (redirect) {
      redirects[redirect] = i;
    } else if (price == null) {
      errors.push(key);
    } else {
      remapped.push({
        price,
        timestamp,
        key,
        adapter,
        confidence,
        decimals,
        symbol,
      });
    }
  });

  const redirectData = await Promise.all(
    Object.values(redirects).map((r: DbEntry) => {
      return getTVLOfRecordClosestToTimestamp(r.redirect, r.SK, 12 * 60 * 60);
    }),
  );

  redirectData.map((r) => {
    const {
      timestamp,
      PK: key,
      adapter,
      confidence,
      decimals,
      symbol,
    } = redirects[r.PK];

    remapped.push({
      price: r.price,
      timestamp,
      key,
      adapter,
      confidence,
      decimals,
      symbol,
    });

    return;
  });

  console.error(`${errors.length} errors in storing to coins2`);

  return remapped;
}
async function queryRedis(values: Coin[]): Promise<CoinDict> {
  if (values.length == 0) return {};
  const redis: Redis = new Redis();
  const keys: string[] = values.map((v: Coin) => v.key);

  console.log(`${values.length} queried`);
  let res = await redis.mget(keys);
  const jsonValues: { [key: string]: Coin } = {};
  res.map((v: string | null) => {
    if (!v) return;
    try {
      const json: Coin = JSON.parse(v);
      jsonValues[json.key] = json;
    } catch {
      console.error(`error parsing: ${v}`);
    }
  });
  console.log(`${Object.keys(jsonValues).length} found in RD`);

  // if (valuesRes) await redis.del(keys);
  // const res: any[] = await redis.mget(keys);
  // valuesRes = res.filter((r: any) => r != null);
  // console.log(`${values.length} found after delete`);
  // console.log("DONE RD");

  await redis.quit();
  return jsonValues;
}
async function queryPostgres(values: Coin[]) {
  if (values.length == 0) return [];
  const sql = postgres(pgConnectionString);
  const keys: string[] = values.map((v: Coin) => v.key);

  let data: any[] = await sql`
      select ${sql(pgColumns)} from coins2main where key in ${sql(keys)}
    `;
  console.log(`${data.length} found in PG`);

  // if (value2)
  //   await sql`
  //     delete from coins2main where key in ${sql(keys)}
  //   `;

  // value2 = await sql`
  //     select ${sql(pgColumns)} from coins2main where key in ${sql(keys)}
  //   `;
  // console.log(`${value2.length} found after delete`);
  // console.log("DONE PG");

  await sql.end();
  return data;
}
function sortQueriesByTimestamp(values: Coin[]) {
  const now = getCurrentUnixTimestamp();
  const historicalQueries: Coin[] = [];
  const currentQueries: Coin[] = [];

  values.map((v: Coin) => {
    v.timestamp < now - latency
      ? historicalQueries.push(v)
      : currentQueries.push(v);
  });

  return [currentQueries, historicalQueries];
}
async function combineRedisAndPostgreData(
  redisData: CoinDict,
  historicalQueries: Coin[],
): Promise<CoinDict> {
  const postgresData: Coin[] = await queryPostgres(historicalQueries);
  const combinedData: CoinDict = {};
  postgresData.map((r: Coin) => {
    let coin = redisData[r.key];
    coin.price = r.price;
    coin.timestamp = r.timestamp;
    coin.confidence = r.confidence;
    combinedData[r.key] = coin;
  });

  return combinedData;
}
async function readCoins2(values: Coin[]): Promise<CoinDict> {
  const [currentQueries, historicalQueries] = sortQueriesByTimestamp(values);

  const redisData: CoinDict = await queryRedis(currentQueries);
  let a =
    historicalQueries.length > 0
      ? redisData
      : await combineRedisAndPostgreData(redisData, historicalQueries);

  return a;
}
async function writeCoins2(values: Coin[]) {
  const redis: Redis = new Redis();
  const sql = postgres(pgConnectionString);
  // REDIS
  const strings: { [key: string]: string } = {};
  values.map((v: Coin) => {
    strings[v.key] = JSON.stringify(v);
  });
  await redis.mset(strings);

  // POSTGRES
  await sql`
    insert into coins2main 
    ${sql(values, "key", "timestamp", "price", "confidence")} 
    on conflict (key) do 
    update set 
      timestamp = excluded.timestamp, 
      price = excluded.price, 
      confidence = excluded.confidence
    `;

  await redis.quit();
  await sql.end();
}
export async function batchWrite2(values: Coin[]) {
  read ? readCoins2(values) : writeCoins2(values);
}
