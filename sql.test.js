import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import { useDatabase } from './sql.js'

// 优先加载项目根目录 .env（可选）；不存在则用进程已有环境变量，文件内不含任何明文凭据
try { process.loadEnvFile?.() } catch { /* 忽略：直接用 process.env */ }

// 集成测试所需的真实库配置，全部来自环境变量
const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE
}
const hasDbConfig = Boolean(DB_CONFIG.user && DB_CONFIG.password && DB_CONFIG.database)
// 纯逻辑测试用的假配置：不触发真实连接即可构造 useDatabase
const FAKE = { host: '127.0.0.1', port: 3306, user: 'u', password: 'p', database: 'd' }
// 未配置数据库时只跳过「需要连库」的用例，纯逻辑用例仍照常执行
const dbTest = hasDbConfig ? test : ((name, fn) => test.skip(name, fn))

// 每次运行使用唯一表名，after 只删自己建的表，绝不触碰库里已有数据
const TABLE = `smc_test_${Date.now()}`
const BIG_TABLE = `smc_big_${Date.now()}`

let admin // 独立 mysql2 连接，负责建表/清表/造数据，不经过被测代码
let db    // allowRawSql: true，覆盖 execute / selectRow 及全部 CRUD

before(async () => {
  if (!hasDbConfig) {
    console.log('[sql.test] 未检测到 DB_USER/DB_PASSWORD/DB_DATABASE，跳过需连库的集成用例')
    return
  }
  admin = await mysql.createConnection({
    host: DB_CONFIG.host, port: DB_CONFIG.port, user: DB_CONFIG.user,
    password: DB_CONFIG.password, database: DB_CONFIG.database, supportBigNumbers: true
  })
  await admin.query(`
    CREATE TABLE \`${TABLE}\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`nickname\` VARCHAR(255) NULL DEFAULT NULL,
      \`email\` VARCHAR(255) NULL DEFAULT NULL,
      \`score\` INT NULL DEFAULT NULL,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await admin.query(`
    CREATE TABLE \`${BIG_TABLE}\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`v\` VARCHAR(16) NULL DEFAULT NULL,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  // 直接落在 > 2^53 区间，验证 supportBigNumbers 不丢精度
  await admin.query(`ALTER TABLE \`${BIG_TABLE}\` AUTO_INCREMENT = 9007199254740992`)
  db = useDatabase({ ...DB_CONFIG, allowRawSql: true })
})

after(async () => {
  if (db) await db.close()
  if (admin) {
    await admin.query(`DROP TABLE IF EXISTS \`${TABLE}\``)
    await admin.query(`DROP TABLE IF EXISTS \`${BIG_TABLE}\``)
    await admin.end()
  }
})

/** 清空测试表并插入固定 3 行，含单引号与 NULL，保证用例互不依赖 */
async function resetFixture() {
  await admin.query(`DELETE FROM \`${TABLE}\``)
  await admin.execute(
    `INSERT INTO \`${TABLE}\` (\`nickname\`, \`email\`, \`score\`) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
    ['Alice', 'alice@example.com', 10, 'Bob', 'bob@example.com', 20, "O'Brien", "o'brien@example.com", null]
  )
}

/** 返回测试表当前行数 */
async function countRows() {
  const [rows] = await admin.execute(`SELECT COUNT(*) AS n FROM \`${TABLE}\``)
  return Number(rows[0].n)
}

// ==================== 纯逻辑用例（无需连库）====================

test('useDatabase 返回完整的方法集合', () => {
  const api = useDatabase(FAKE)
  const methods = ['execute', 'query', 'deleteRow', 'getRow', 'insertRow', 'updateRow', 'selectRow', 'close']
  for (const name of methods) assert.equal(typeof api[name], 'function', `应提供 ${name} 方法`)
})

test('缺少必需配置时明确报错，且不再默认使用 root', () => {
  assert.throws(() => useDatabase(), /缺少必需配置: database/)
  assert.throws(() => useDatabase({}), /缺少必需配置: database/)
  assert.throws(() => useDatabase({ database: 'x' }), /缺少必需配置: user/)
  assert.throws(() => useDatabase({ database: 'x', user: 'u' }), /缺少必需配置: password/)
  assert.throws(() => useDatabase(null), /数据库配置必须是一个对象/)
})

test('默认禁用 execute / selectRow（裸 SQL 逃生舱默认关闭）', async () => {
  const api = useDatabase(FAKE)
  await assert.rejects(() => api.execute('SELECT 1', []), /原始 SQL 执行默认禁用/)
  await assert.rejects(() => api.selectRow('SELECT 1', []), /原始 SQL 执行默认禁用/)
  await api.close()
})

test('默认配置下安全封装方法仍可进入参数化流程（不被裸 SQL 门禁挡）', async () => {
  const api = useDatabase(FAKE)
  await assert.rejects(() => api.query('bad; DROP', {}), /非法的表名\/列名/)
  await api.close()
})

test('值类型白名单：拒绝对象 / 数组 / Map / Symbol / 函数 / undefined 作为值', async () => {
  const api = useDatabase(FAKE)
  for (const [name, value] of [
    ['普通对象', { a: 1 }], ['数组', [1, 2]], ['Map', new Map()],
    ['Symbol', Symbol('x')], ['函数', () => 1], ['undefined', undefined]
  ]) {
    await assert.rejects(() => api.insertRow('t', { v: value }), /不支持的参数值类型/, `${name} 应被拒绝`)
  }
  await api.close()
})

test('conditions 必须是普通对象：Map/Set/Date/数组/类实例被拒绝（不再静默返回全表）', async () => {
  const api = useDatabase(FAKE)
  class Box { constructor() { this.id = 1 } }
  for (const [name, value] of [
    ['Map', new Map([['id', 1]])], ['Set', new Set([1])], ['Date', new Date()],
    ['数组', []], ['类实例', new Box()], ['null', null]
  ]) {
    await assert.rejects(() => api.query('t', value), /必须是一个普通对象/, `${name} 应被拒绝`)
  }
  await api.close()
})

test('SQL 形状护栏：非数组 params / 空 SQL / 占位符不对齐 / 超长 / 参数过多', async () => {
  const api = useDatabase({ ...FAKE, allowRawSql: true })
  await assert.rejects(() => api.execute('SELECT 1', undefined), /params 须为数组/)
  await assert.rejects(() => api.execute('', []), /SQL 语句不能为空/)
  await assert.rejects(() => api.execute('SELECT ?, ?', [1]), /占位符数量\(2\)与参数数量\(1\)不一致/)
  await assert.rejects(() => api.execute('SELECT ' + 'a'.repeat(100001), []), /SQL 过长/)
  await assert.rejects(
    () => api.execute(`SELECT ${Array(1001).fill('?').join(',')}`, Array(1001).fill(1)),
    /参数过多/
  )
  await api.close()
})

test('标识符白名单：注入型 / 中文 / 超长 表名、列名、条件键名被拒绝', async () => {
  const api = useDatabase(FAKE)
  await assert.rejects(() => api.query('t; DROP TABLE t; --', {}), /非法的表名\/列名/)
  await assert.rejects(() => api.query('t WHERE 1=1', {}), /非法的表名\/列名/)
  await assert.rejects(() => api.query('t', { 'x` = `x` OR 1=1 -- ': 1 }), /非法的表名\/列名/)
  await assert.rejects(() => api.query('t', {}, 'x, (SELECT 1)'), /非法的表名\/列名/)
  await assert.rejects(() => api.query('用户', {}), /非法的表名\/列名/, '中文标识符为已知限制')
  await assert.rejects(() => api.query('a'.repeat(65), {}), /非法的表名\/列名/, '超长标识符')
  await api.close()
})

test('close() 幂等：无连接时多次调用不抛错', async () => {
  const api = useDatabase(FAKE)
  await api.close()
  await api.close()
  await api.close()
})

// ==================== 集成用例（需真实数据库）====================

dbTest('allowRawSql: true 后 execute / selectRow 可用', async () => {
  const rows = await db.execute('SELECT ? AS val, ? AS num', ['hello', 7])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].val, 'hello')
  assert.equal(Number(rows[0].num), 7)
  const one = await db.selectRow('SELECT ? AS val', ['ok'])
  assert.equal(one.val, 'ok')
})

dbTest('execute 正确绑定值并返回结果集', async () => {
  await resetFixture()
  const rows = await db.execute(`SELECT * FROM \`${TABLE}\` WHERE nickname = ? AND score > ?`, ['Alice', 5])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].nickname, 'Alice')
})

dbTest('去掉引号黑名单：CONCAT / IFNULL / DATE_FORMAT 等合法 SQL 可执行', async () => {
  const a = await db.execute("SELECT CONCAT(?, '!') AS v", ['hi'])
  assert.equal(a[0].v, 'hi!')
  const b = await db.execute("SELECT IFNULL(?, 'N/A') AS v", [null])
  assert.equal(b[0].v, 'N/A')
  const c = await db.execute("SELECT DATE_FORMAT('2020-01-02', '%Y') AS y", [])
  assert.equal(c[0].y, '2020')
})

dbTest('底层错误脱敏，并保留 code / cause', async () => {
  await assert.rejects(
    () => db.execute('SELECT * FROM `smc_no_such_table_xyz`', []),
    (err) => {
      assert.match(err.message, /数据库操作失败/, '对外消息应脱敏为通用文案')
      assert.ok(!err.message.includes('smc_no_such_table_xyz'), '消息不得含表名')
      assert.ok(!err.message.includes(DB_CONFIG.database), '消息不得含库名')
      assert.equal(err.code, 'ER_NO_SUCH_TABLE', '应保留 code 供编程判定')
      assert.ok(err.cause instanceof Error, '应保留 cause')
      assert.match(err.cause.message, /smc_no_such_table_xyz/, 'cause 保留原文便于排错')
      return true
    }
  )
})

dbTest('sql 日志开关不打印参数明文', async () => {
  const logger = useDatabase({ ...DB_CONFIG, allowRawSql: true, sql: true })
  const logs = []
  const orig = console.log
  console.log = (...args) => logs.push(args.map(String).join(' '))
  try {
    await logger.execute('SELECT ? AS secret, ? AS pwd', ['SUPER_SECRET_123', 'P@ssw0rd'])
  } finally {
    console.log = orig
    await logger.close()
  }
  const joined = logs.join('\n')
  assert.ok(joined.length > 0, '应打印脱敏日志')
  assert.ok(!joined.includes('SUPER_SECRET_123') && !joined.includes('P@ssw0rd'), '不得出现参数明文')
  assert.match(joined, /2 个值已隐藏/, '应标注参数已隐藏')
})

dbTest('query 无条件 / 单条件 / 多条件 AND / 列写法', async () => {
  await resetFixture()
  assert.equal((await db.query(TABLE)).length, 3)
  const one = await db.query(TABLE, { nickname: 'Alice' })
  assert.equal(one.length, 1)
  assert.equal(one[0].email, 'alice@example.com')
  assert.equal((await db.query(TABLE, { nickname: 'Bob', score: 20 })).length, 1)
  assert.equal((await db.query(TABLE, { nickname: 'Bob', score: 999 })).length, 0)

  const all = await db.query(TABLE, {}, '*')
  assert.ok('email' in all[0])
  const arr = await db.query(TABLE, {}, ['id', 'nickname'])
  assert.deepEqual(Object.keys(arr[0]).sort(), ['id', 'nickname'])
  const str = await db.query(TABLE, {}, 'id, nickname')
  assert.deepEqual(Object.keys(str[0]).sort(), ['id', 'nickname'])
})

dbTest('query 注入串作为值不绕过过滤', async () => {
  await resetFixture()
  const rows = await db.query(TABLE, { nickname: "x' OR '1'='1" })
  assert.equal(rows.length, 0)
  assert.equal(await countRows(), 3)
})

dbTest('query null 条件转 IS NULL', async () => {
  await resetFixture()
  const nulls = await db.query(TABLE, { score: null })
  assert.equal(nulls.length, 1)
  assert.equal(nulls[0].nickname, "O'Brien")
})

dbTest('insertRow 插入并读回 insertId', async () => {
  await resetFixture()
  const id = await db.insertRow(TABLE, { nickname: 'Carol', email: 'c@e.com', score: 30 })
  assert.ok(Number(id) > 0)
  const row = await db.getRow(TABLE, id)
  assert.equal(row.nickname, 'Carol')
  assert.equal(Number(row.score), 30)
  assert.equal(await countRows(), 4)
})

dbTest('insertRow 原样写入单引号与注入片段', async () => {
  await resetFixture()
  const evil = "x'); DROP TABLE user; -- "
  const id = await db.insertRow(TABLE, { nickname: "O'Brien", email: evil, score: null })
  const row = await db.getRow(TABLE, id)
  assert.equal(row.nickname, "O'Brien")
  assert.equal(row.email, evil)
  assert.equal(row.score, null)
  assert.equal(await countRows(), 4)
})

dbTest('insertRow 拒绝空数据 / 非对象', async () => {
  await assert.rejects(() => db.insertRow(TABLE, {}), /插入数据不能为空/)
  await assert.rejects(() => db.insertRow(TABLE, null), /必须是一个普通对象/)
  await assert.rejects(() => db.insertRow(TABLE, []), /必须是一个普通对象/)
})

dbTest('insertRow 合法值类型：bigint 转字符串 / boolean / Date / Buffer', async () => {
  const id = await db.insertRow(TABLE, { nickname: 10n, email: 'x', score: true })
  const row = await db.getRow(TABLE, id)
  assert.equal(row.nickname, '10', 'bigint 应显式转成字符串')
  assert.equal(Number(row.score), 1, 'boolean 应写入 1')
  const id2 = await db.insertRow(TABLE, { nickname: new Date('2020-01-01'), email: Buffer.from('hi'), score: 1 })
  assert.ok(Number(id2) > 0, 'Date / Buffer 应可写入')
})

dbTest('getRow 按主键 / 不存在 null / 注入型 id 不命中', async () => {
  await resetFixture()
  const [target] = await db.query(TABLE, { nickname: 'Alice' })
  assert.equal((await db.getRow(TABLE, target.id)).nickname, 'Alice')
  assert.equal(await db.getRow(TABLE, 99999999), null)
  assert.equal(await db.getRow(TABLE, '0 OR 1=1'), null)
  assert.equal(await countRows(), 3)
})

dbTest('updateRow 按主键更新不改 id', async () => {
  await resetFixture()
  const [target] = await db.query(TABLE, { nickname: 'Alice' })
  await db.updateRow(TABLE, { id: target.id, nickname: "A'lice", score: 99 })
  const row = await db.getRow(TABLE, target.id)
  assert.equal(row.nickname, "A'lice")
  assert.equal(Number(row.score), 99)
  assert.equal(Number(row.id), Number(target.id))
  assert.equal(await countRows(), 3)
})

dbTest('updateRow 缺少 id / 无可更新字段被拒绝', async () => {
  await assert.rejects(() => db.updateRow(TABLE, { nickname: 'X' }), /缺少 id 字段/)
  await assert.rejects(() => db.updateRow(TABLE, { id: 1 }), /没有可更新的字段/)
  await assert.rejects(() => db.updateRow(TABLE, null), /必须是一个普通对象/)
})

dbTest('updateRow 注入型 id 不批量修改', async () => {
  await resetFixture()
  try { await db.updateRow(TABLE, { id: '0 OR 1=1', nickname: 'HACKED' }) } catch { /* 值绑定可能类型报错，均视为未命中 */ }
  assert.equal((await db.query(TABLE, { nickname: 'HACKED' })).length, 0)
  assert.equal(await countRows(), 3)
})

dbTest('deleteRow 按主键删除 / 注入型 id 不清空表', async () => {
  await resetFixture()
  const [target] = await db.query(TABLE, { nickname: 'Bob' })
  await db.deleteRow(TABLE, target.id)
  assert.equal(await db.getRow(TABLE, target.id), null)
  assert.equal(await countRows(), 2)

  await resetFixture()
  try { await db.deleteRow(TABLE, '0 OR 1=1') } catch { /* 忽略 */ }
  assert.equal(await countRows(), 3)
})

dbTest('selectRow 单条 / 空 null / 多条抛错', async () => {
  await resetFixture()
  assert.equal((await db.selectRow(`SELECT * FROM \`${TABLE}\` WHERE nickname = ?`, ['Alice'])).nickname, 'Alice')
  assert.equal(await db.selectRow(`SELECT * FROM \`${TABLE}\` WHERE nickname = ?`, ['Nobody']), null)
  await assert.rejects(() => db.selectRow(`SELECT * FROM \`${TABLE}\``, []), /期望最多 1 条，实际 3 条/)
})

dbTest('selectRow 同样受参数化约束', async () => {
  await assert.rejects(() => db.selectRow(`SELECT * FROM \`${TABLE}\` WHERE nickname = ?`), /params 须为数组/)
  await assert.rejects(() => db.selectRow('SELECT ?, ?', [1]), /占位符数量/)
})

dbTest('close 关闭后连接不可用，且幂等（有连接时多次调用不抛错）', async () => {
  const separate = useDatabase({ ...DB_CONFIG, allowRawSql: true })
  const rows = await separate.execute('SELECT 1 AS ok', [])
  assert.equal(Number(rows[0].ok), 1)
  await separate.close()
  await separate.close()   // 幂等：旧版此处会抛 closed state
  await separate.close()
  await assert.rejects(() => separate.execute('SELECT 1 AS ok', []), /数据库操作失败/)
})

dbTest('默认配置（allowRawSql: false）下 CRUD 安全封装端到端可用', async () => {
  const safe = useDatabase(DB_CONFIG)
  try {
    const id = await safe.insertRow(TABLE, { nickname: 'Safe', email: 's@e.com', score: 1 })
    assert.ok(Number(id) > 0)
    assert.equal((await safe.getRow(TABLE, id)).nickname, 'Safe')
    await safe.updateRow(TABLE, { id, nickname: 'Safe2' })
    assert.equal((await safe.getRow(TABLE, id)).nickname, 'Safe2')
    assert.ok((await safe.query(TABLE, { nickname: 'Safe2' })).length >= 1)
    await safe.deleteRow(TABLE, id)
    assert.equal(await safe.getRow(TABLE, id), null)
    await assert.rejects(() => safe.execute('SELECT 1', []), /原始 SQL 执行默认禁用/)
    await assert.rejects(() => safe.selectRow('SELECT 1', []), /原始 SQL 执行默认禁用/)
  } finally {
    await safe.close()
  }
})

dbTest('supportBigNumbers 默认开启：BIGINT 主键不丢精度', async () => {
  const got = await db.insertRow(BIG_TABLE, { v: 'x' })
  assert.equal(typeof got, 'string', '超精度 insertId 应为字符串')
  const [real] = await admin.query(`SELECT CAST(\`id\` AS CHAR) AS id FROM \`${BIG_TABLE}\` WHERE \`v\` = ?`, ['x'])
  assert.equal(String(got), real[0].id, 'insertId 应与库里真实 id 完全一致')
})

dbTest('额外 mysql2 配置可透传（connectionLimit / connectTimeout 不影响查询）', async () => {
  const custom = useDatabase({ ...DB_CONFIG, connectionLimit: 2, connectTimeout: 5000, allowRawSql: true })
  try {
    const rows = await custom.execute('SELECT 1 AS ok', [])
    assert.equal(Number(rows[0].ok), 1)
  } finally {
    await custom.close()
  }
})
