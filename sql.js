import mysql from 'mysql2/promise'

/**
 * 标识符白名单：字母或下划线开头，后续只允许字母、数字、下划线、$
 * 说明：MySQL 支持中文等 Unicode 标识符，本库为降低注入风险仅开放 ASCII 白名单，
 * 详见 README「已知限制」。
 */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/

// 资源护栏：防止无界输入导致内存 / 连接池耗尽
const MAX_IDENTIFIER_LENGTH = 64            // MySQL 标识符长度上限
const MAX_SQL_LENGTH = 100_000              // 单条 SQL 文本字符数上限
const MAX_PARAMS = 1000                     // 占位符 / 参数个数上限
const MAX_PARAM_BYTES = 16 * 1024 * 1024    // 单个参数值字节数上限（16 MB）

/**
 * 校验并转义 SQL 标识符（表名 / 列名）
 * @param {string} name 标识符
 * @returns {string} 带反引号的安全标识符
 */
function escapeIdentifier(name) {
  if (typeof name !== 'string' || name.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`非法的表名/列名: ${String(name)}，仅支持字母、数字、下划线、$ 且不以数字开头，长度 ≤ ${MAX_IDENTIFIER_LENGTH}`)
  }
  return mysql.escapeId(name)
}

/**
 * 构造 SELECT 的列表达式，支持 '*'、单个列名、逗号分隔列名或列名数组
 * @param {string|string[]} columns 列
 * @returns {string} 安全的列表达式
 */
function buildColumns(columns) {
  if (columns === undefined || columns === null || columns === '*') {
    return '*'
  }
  const list = (Array.isArray(columns) ? columns : String(columns).split(','))
    .map(item => String(item).trim())
    .filter(item => item.length > 0)
  if (list.length === 0) {
    throw new Error('查询列不能为空')
  }
  return list.map(item => (item === '*' ? '*' : escapeIdentifier(item))).join(', ')
}

/**
 * 断言 value 是普通对象：仅接受对象字面量 / Object.create(null)。
 * 拒绝 Map/Set/Date/数组/类实例，避免 Object.keys 为空导致条件被静默忽略返回全表。
 * @param {*} value 待校验值
 * @param {string} label 错误信息中的名称
 */
function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是一个普通对象`)
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${label}必须是一个普通对象（不接受 Map/Set/Date/类实例）`)
  }
}

/**
 * 校验参数值字节数不超过上限
 * @param {number} size 字节数
 */
function assertByteLength(size) {
  if (size > MAX_PARAM_BYTES) {
    throw new Error(`参数值过大: ${size} 字节，上限 ${MAX_PARAM_BYTES} 字节`)
  }
}

/**
 * 校验单个绑定值的类型与大小，只允许白名单类型，杜绝静默变形 / DoS。
 * bigint 显式转成字符串（与 mysql2 行为一致但更可预期）。
 * @param {*} value 绑定值
 * @returns {*} 规范化后的值
 */
function assertValue(value) {
  const type = typeof value
  if (value === null) return null
  if (type === 'string') {
    assertByteLength(Buffer.byteLength(value, 'utf8'))
    return value
  }
  if (type === 'boolean') return value
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('参数值不能是 NaN / Infinity')
    }
    return value
  }
  if (type === 'bigint') return String(value)
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('参数值包含无效的 Date')
    }
    return value
  }
  if (Buffer.isBuffer(value)) {
    assertByteLength(value.length)
    return value
  }
  const kind = type === 'object'
    ? (Array.isArray(value) ? 'Array' : (value?.constructor?.name || 'Object'))
    : type
  throw new Error(`不支持的参数值类型: ${kind}，只允许 string / number / boolean / bigint / Date / Buffer / null`)
}

/**
 * 统计 SQL 中真正的占位符 ? 数量：先剥离引号 / 反引号包裹的片段，
 * 避免把字符串字面量里的 '?' 误当占位符（仅用于形状校验，不作安全判定）。
 * @param {string} sqlText SQL 文本
 * @returns {number} 占位符个数
 */
function countPlaceholders(sqlText) {
  const stripped = sqlText.replace(/`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*"/g, '')
  return (stripped.match(/\?/g) || []).length
}

/**
 * 校验 SQL 形状：非空、长度上限、params 为数组、数量上限、占位符与参数对齐。
 * 注：不再以「检测引号/注释」判定注入——默认不暴露裸 SQL 入口；
 * 开启 allowRawSql 后由调用方对 SQL 文本全权负责（见 README 顶部警告）。
 * @param {string} sqlText SQL 语句
 * @param {*} params 参数数组
 */
function assertQueryShape(sqlText, params) {
  if (typeof sqlText !== 'string' || sqlText.trim() === '') {
    throw new Error('SQL 语句不能为空')
  }
  if (sqlText.length > MAX_SQL_LENGTH) {
    throw new Error(`SQL 过长: ${sqlText.length} 字符，上限 ${MAX_SQL_LENGTH}`)
  }
  if (!Array.isArray(params)) {
    throw new Error('必须使用参数化查询，params 须为数组，值一律用 ? 占位符')
  }
  if (params.length > MAX_PARAMS) {
    throw new Error(`参数过多: ${params.length} 个，上限 ${MAX_PARAMS}`)
  }
  const placeholders = countPlaceholders(sqlText)
  if (placeholders !== params.length) {
    throw new Error(`占位符数量(${placeholders})与参数数量(${params.length})不一致，值必须用 ? 绑定`)
  }
}

/**
 * 把底层错误包装成脱敏错误：message 统一通用文案（不回传库/表/列名或 SQL 片段），
 * 用 cause 保留原始错误，并透传 code / errno / sqlState 供编程式判定。
 * @param {*} err 原始错误
 * @returns {Error} 脱敏后的错误
 */
function wrapError(err) {
  const wrapped = new Error('数据库操作失败，请检查服务端日志', { cause: err })
  wrapped.code = err?.code
  wrapped.errno = err?.errno
  wrapped.sqlState = err?.sqlState
  return wrapped
}

/**
 * 创建数据库操作对象。连接池在调用时创建一次，被所有查询复用；
 * 使用完毕必须调用 close() 释放，否则 Node 进程不会退出。
 *
 * 安全默认值：不提供 user 默认值（须显式给最小权限账号）；默认禁用 execute/selectRow
 * 两个裸 SQL 入口（确需使用请显式传 allowRawSql: true）；默认开启 supportBigNumbers。
 *
 * @param {object} dbConfig 数据库配置（额外字段透传给 mysql2.createPool）
 * @returns {object} 查询方法集合
 */
export function useDatabase(dbConfig = {}) {
  if (dbConfig === null || typeof dbConfig !== 'object' || Array.isArray(dbConfig)) {
    throw new Error('数据库配置必须是一个对象')
  }
  const {
    database, password, host = '127.0.0.1', user, port = 3306, charset = 'utf8mb4',
    sql = false, allowRawSql = false,
    ...extra  // 其余字段透传给 mysql2（connectionLimit / ssl / connectTimeout / timezone ...）
  } = dbConfig

  if (typeof database !== 'string' || database.trim() === '') {
    throw new Error('缺少必需配置: database')
  }
  if (typeof user !== 'string' || user.trim() === '') {
    throw new Error('缺少必需配置: user（本库不再默认使用 root，请显式提供最小权限账号）')
  }
  if (typeof password !== 'string') {
    throw new Error('缺少必需配置: password（如为空密码请显式传空字符串）')
  }

  const pool = mysql.createPool({
    host, user, password, database, port, charset,
    supportBigNumbers: true,   // 默认开启，避免 BIGINT 主键精度丢失；可通过 extra 覆盖
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 100,           // 有限队列，避免无界堆积
    ...extra                  // 用户显式配置优先
  })

  let closed = false

  /** 裸 SQL 门禁：默认禁用，显式开 allowRawSql 才放行 */
  function assertRawSqlAllowed() {
    if (!allowRawSql) {
      throw new Error(
        '原始 SQL 执行默认禁用。如确需使用 execute/selectRow，请在 useDatabase({ allowRawSql: true }) 中显式开启，' +
        '并确保 SQL 文本为硬编码常量、绝不拼接任何外部输入。'
      )
    }
  }

  /**
   * 内部统一执行入口（不暴露）：形状校验 + 值校验 + 脱敏日志 + 错误包装。
   * 所有安全封装方法与已开启的裸 SQL 入口都汇聚到这里。
   * @param {string} sqlText SQL 语句
   * @param {Array} params 参数数组
   * @returns {Promise<*>} 结果数组 / ResultSetHeader
   */
  async function runQuery(sqlText, params) {
    assertQueryShape(sqlText, params)
    const safeParams = params.map(assertValue)
    if (sql) {
      // 调试日志：打印 SQL 模板与参数个数，绝不打印参数值（含口令/PII）
      console.log(`[safe-mysql-crud] SQL: ${sqlText} | PARAMS: [${safeParams.length} 个值已隐藏]`)
    }
    try {
      const [rows] = await pool.execute(sqlText, safeParams)
      return rows
    } catch (err) {
      throw wrapError(err)
    }
  }

  /** 内部「取单条」辅助（供 getRow 与已开启的 selectRow 复用） */
  async function selectOne(sqlText, params) {
    const rows = await runQuery(sqlText, params)
    if (!Array.isArray(rows)) {
      throw new Error('查询结果异常: 返回结果不是数组')
    }
    if (rows.length > 1) {
      throw new Error(`查询结果异常: 期望最多 1 条，实际 ${rows.length} 条`)
    }
    return rows[0] || null
  }

  /**
   * 提取数据对象中合法键名并校验键名为合法标识符
   * @param {object} data 数据对象（必须是普通对象）
   * @returns {string[]} 键名列表
   */
  function getValidKeys(data) {
    assertPlainObject(data, '参数')
    const keys = Object.keys(data)
    keys.forEach(escapeIdentifier)
    return keys
  }

  /**
   * 条件查询，conditions 为等值条件（值为 null 时自动转为 IS NULL）
   * @param {string} table 表名
   * @param {object} conditions 等值条件（必须是普通对象）
   * @param {string|string[]} columns 查询列，默认 '*'
   * @returns {Promise<Array>} 结果集
   */
  async function query(table, conditions = {}, columns = '*') {
    const tableId = escapeIdentifier(table)
    const columnStr = buildColumns(columns)
    const keys = getValidKeys(conditions)
    const values = []
    const whereConditions = keys.map(key => {
      const column = mysql.escapeId(key)
      if (conditions[key] === null) {
        return `${column} IS NULL`
      }
      values.push(conditions[key])
      return `${column} = ?`
    })
    let sqlText = `SELECT ${columnStr} FROM ${tableId}`
    if (whereConditions.length > 0) {
      sqlText += ` WHERE ${whereConditions.join(' AND ')}`
    }
    return await runQuery(sqlText, values)
  }

  /**
   * 按主键删除
   * @param {string} table 表名
   * @param {*} id 主键值
   */
  async function deleteRow(table, id) {
    return await runQuery(`DELETE FROM ${escapeIdentifier(table)} WHERE id = ?`, [id])
  }

  /**
   * 按主键查询单条
   * @param {string} table 表名
   * @param {*} id 主键值
   */
  async function getRow(table, id) {
    return await selectOne(`SELECT * FROM ${escapeIdentifier(table)} WHERE id = ?`, [id])
  }

  /**
   * 插入数据
   * @param {string} table 表名
   * @param {object} data 字段与值
   * @returns {Promise<number|string>} 自增主键 insertId（大整数时为字符串）
   */
  async function insertRow(table, data) {
    const keys = getValidKeys(data)
    if (keys.length === 0) {
      throw new Error('插入数据不能为空')
    }
    const columns = keys.map(key => mysql.escapeId(key)).join(', ')
    const placeholders = keys.map(() => '?').join(', ')
    const values = keys.map(key => data[key])
    const result = await runQuery(`INSERT INTO ${escapeIdentifier(table)} (${columns}) VALUES (${placeholders})`, values)
    return result.insertId
  }

  /**
   * 按主键更新，id 不参与 SET
   * @param {string} table 表名
   * @param {object} data 字段与值，必须含 id
   */
  async function updateRow(table, data) {
    assertPlainObject(data, '更新数据')
    if (data.id === undefined || data.id === null) {
      throw new Error('更新数据时缺少 id 字段')
    }
    const keys = getValidKeys(data)
    const setParts = []
    const values = []
    for (const key of keys) {
      if (key === 'id') continue
      setParts.push(`${mysql.escapeId(key)} = ?`)
      values.push(data[key])
    }
    if (setParts.length === 0) {
      throw new Error('更新数据中没有可更新的字段')
    }
    values.push(data.id)
    return await runQuery(
      `UPDATE ${escapeIdentifier(table)} SET ${setParts.join(', ')} WHERE id = ?`,
      values
    )
  }

  /**
   * 执行参数化 SQL（默认禁用，需 allowRawSql: true）。
   * 警告：SQL 文本必须是硬编码常量，禁止拼接任何外部输入。
   * @param {string} sqlText 含 ? 占位符的 SQL
   * @param {Array} params 参数数组，无参数时传 []
   * @returns {Promise<*>} 结果数组 / ResultSetHeader
   */
  async function execute(sqlText, params) {
    assertRawSqlAllowed()
    return await runQuery(sqlText, params)
  }

  /**
   * 执行参数化查询并确保最多返回一条（默认禁用，需 allowRawSql: true）
   * @param {string} sqlText 含 ? 占位符的 SQL
   * @param {Array} params 参数数组
   * @returns {Promise<object|null>} 单条记录或 null
   */
  async function selectRow(sqlText, params) {
    assertRawSqlAllowed()
    return await selectOne(sqlText, params)
  }

  /**
   * 关闭连接池（幂等，可安全多次调用）
   */
  async function close() {
    if (closed) return
    closed = true
    await pool.end()
  }

  return {
    execute,
    query,
    deleteRow,
    getRow,
    insertRow,
    updateRow,
    selectRow,
    close
  }
}
