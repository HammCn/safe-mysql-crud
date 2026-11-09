# safe-mysql-crud

> ⚠️ **安全警告（务必先读）**
>
> 本库默认**禁用** `execute` / `selectRow` 两个裸 SQL 入口。
> 如确需通过 `useDatabase({ allowRawSql: true })` 开启，**SQL 文本必须是硬编码常量，禁止拼接任何外部输入**——包括数字、
`ORDER BY` / `LIMIT` / 表名 / 列名。
> 一旦把用户输入拼进 SQL 文本，参数化绑定就形同虚设，等同于把数据库直接暴露给攻击者。
> 日常请只使用 `query` / `insertRow` / `getRow` / `updateRow` / `deleteRow` 这五个安全封装。

一个默认安全的极简 MySQL CRUD 辅助库（ESM，基于 `mysql2/promise`）。值一律通过 `?` 占位符绑定，表名/列名走白名单，默认不暴露裸
SQL 能力。

## 安装

```bash
npm install safe-mysql-crud
```

## 快速上手

凭据由调用方通过环境变量提供，库内不含任何默认值。

```js
import {useDatabase} from 'safe-mysql-crud'

const db = useDatabase({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,          // 必填，请用一个最小权限账号
    password: process.env.DB_PASSWORD,  // 必填
    database: process.env.DB_DATABASE   // 必填
})

const {insertRow, getRow, updateRow, deleteRow, query, close} = db

try {
    const id = await insertRow('user', {nickname: 'Alice', email: 'alice@example.com'})
    await updateRow('user', {id, nickname: 'Alice L'})
    const row = await getRow('user', id)
    const rows = await query('user', {nickname: 'Alice L'})
    await deleteRow('user', id)
} finally {
    await close() // 连接池复用，退出前必须关闭；幂等，可安全重复调用
}
```

## 配置

`useDatabase(config)` 的 `config`：

| 字段                  | 必填 | 默认          | 说明                                                                                                                            |
|---------------------|----|-------------|-------------------------------------------------------------------------------------------------------------------------------|
| `database`          | 是  | —           | 库名                                                                                                                            |
| `user`              | 是  | —           | 账号（**不再默认 `root`**，请显式给最小权限账号）                                                                                                |
| `password`          | 是  | —           | 口令（无默认值；空口令请显式传 `''`）                                                                                                         |
| `host`              | 否  | `127.0.0.1` | 主机                                                                                                                            |
| `port`              | 否  | `3306`      | 端口                                                                                                                            |
| `charset`           | 否  | `utf8mb4`   | 字符集                                                                                                                           |
| `sql`               | 否  | `false`     | 调试日志开关，只打印 SQL 模板与参数个数，**不打印参数值**                                                                                             |
| `allowRawSql`       | 否  | `false`     | 是否启用 `execute` / `selectRow` 两个裸 SQL 入口                                                                                       |
| `supportBigNumbers` | 否  | `true`      | 默认开启，避免 `BIGINT` 主键精度丢失                                                                                                       |
| 其它 mysql2 选项        | 否  | —           | 如 `connectionLimit` / `queueLimit` / `ssl` / `connectTimeout` / `timezone` / `dateStrings`，会透传给 `mysql2.createPool`，且优先于本库默认值 |

## API

只有 `execute` / `selectRow` 受 `allowRawSql` 门禁；其余方法默认即可用。

| 方法                                             | 返回值                               | 说明                                                      |
|------------------------------------------------|-----------------------------------|---------------------------------------------------------|
| `query(table, conditions = {}, columns = '*')` | `Promise<Array>`                  | 等值条件查询；值为 `null` 自动转 `IS NULL`；`conditions` 必须是普通对象     |
| `getRow(table, id)`                            | `Promise<object\|null>`           | 按主键 `id` 取单条，不存在返回 `null`                               |
| `insertRow(table, data)`                       | `Promise<number\|string>`         | 插入并返回自增主键 `insertId`（超精度时为字符串）                          |
| `updateRow(table, data)`                       | `Promise<ResultSetHeader>`        | 按 `data.id` 更新，`id` 不参与 `SET`；`data` 必须含 `id` 且至少一个其它字段 |
| `deleteRow(table, id)`                         | `Promise<ResultSetHeader>`        | 按主键删除                                                   |
| `execute(sql, params)`                         | `Promise<Array\|ResultSetHeader>` | **默认禁用**，需 `allowRawSql: true`；`params` 必须是数组           |
| `selectRow(sql, params)`                       | `Promise<object\|null>`           | **默认禁用**，最多返回一条，多条会抛错                                   |
| `close()`                                      | `Promise<void>`                   | 关闭连接池，幂等                                                |

`columns` 支持 `'*'`、`'a, b'`、`['a','b']`。所有值都必须是 `string / number / boolean / bigint / Date / Buffer / null`
之一；对象、数组、`Symbol`、函数、`undefined` 会被拒绝。

## 安全模型

- **强制参数化**：所有值走 `?` + `pool.execute` 预编译绑定，不参与 SQL 解析。
- **标识符白名单**：表名/列名仅允许 `[A-Za-z_][A-Za-z0-9_$]*`，再经 `escapeId` 加反引号。
- **默认禁用裸 SQL**：`execute` / `selectRow` 默认抛错；开启后由调用方对 SQL 文本全权负责。
- **形状护栏**：校验 SQL 非空、长度上限（100000 字符）、`params` 为数组、占位符数量与参数一致、参数个数上限（1000）、单值大小上限（16
  MB）、有限等待队列。
- **值类型白名单**：拒绝会被静默序列化或变形的类型，避免「传了对象却查不到数据」这类隐性错误。
- **conditions 守门**：`query` 的条件必须是普通对象；`Map` / `Set` / `Date` / 数组 / 类实例会被拒绝，避免条件被静默忽略而返回全表。
- **错误脱敏**：对外 `message` 统一为「数据库操作失败，请检查服务端日志」，不回传库/表/列名或 SQL 片段；原始错误放在
  `error.cause`，并透传 `code` / `errno` / `sqlState` 供编程式判定。
- **日志脱敏**：`sql: true` 只打印 SQL 模板与参数个数，绝不打印参数值（口令、token、PII）。
- **大整数**：默认 `supportBigNumbers: true`，`BIGINT` 超精度时以字符串返回，不丢精度。
- **最小权限**：不提供 `user` 默认值，启动时校验 `database` / `user` / `password` 必填。

## 已知限制

- **中文 / Unicode 标识符不支持**：标识符白名单为 ASCII，中文表名或列名会被拒绝。这是为降低注入风险刻意保留的限制。
- **裸 SQL 入口风险自担**：`allowRawSql: true` 后，静态检测**无法**证明 SQL 文本没被拼过外部输入；本库不对拼接造成的注入负责。
- **返回值契约**：`updateRow` / `deleteRow` 返回原始 `ResultSetHeader`，`affectedRows === 0`（改/删 0 行）不算错误；
  `insertId` 在大整数时为字符串。
- **`query` 只做等值 / `IS NULL`**：不支持 `OR` / `LIKE` / 范围 / 排序 / 分页 / 联表，复杂查询请用参数化原生 SQL（自行负责）。
- **需要最小权限账号**：请勿用 `root` 或生产口令跑测试与示例。
- **无 TypeScript 声明**：纯 JavaScript，暂不附带 `.d.ts`。
- **集成测试依赖真实 MySQL**：见下节。

## 测试

测试会连真实 MySQL（自建唯一临时表并自动清理）。凭据通过环境变量提供：

```bash
cp .env.example .env      # 填入你自己的测试库信息（.env 已被 .gitignore 忽略）
npm test

# 或用命令行临时注入
DB_USER=xxx DB_PASSWORD=xxx DB_DATABASE=xxx npm test
```

未检测到 `DB_USER` / `DB_PASSWORD` / `DB_DATABASE` 时，9 个纯逻辑用例照常运行、连库用例自动跳过（退出码仍为 0）。

## 凭据安全

- 本仓库的示例与测试**不含任何真实口令**，全部从环境变量读取。
- **切勿**把口令写进代码、示例、测试或提交到 Git。
- 若某个口令曾被写进文件、提交过或随包发布过，请**按已泄露处理并立即轮换**（npm 内容无法真正撤回）。

## 许可证

[MIT](./LICENSE) © 2026 Hamm.cn
