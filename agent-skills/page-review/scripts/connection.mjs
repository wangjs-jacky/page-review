import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";

export function configPath(env = process.env) {
  const file =
    env.PAGE_REVIEW_CONFIG ||
    path.join(
      env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "page-review",
      "connection.json",
    );
  if (!path.isAbsolute(file)) throw new Error("连接配置需要绝对路径");
  return file;
}

export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("连接配置JSON无效，请重新保存首次连接配置");
  let origin;
  try {
    origin = new URL(value.apiUrl);
  } catch {
    throw new Error("连接配置缺少有效API地址");
  }
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(origin.hostname)
      ))
  )
    throw new Error("配置需要HTTPS源地址；本机验证允许loopback");
  if (!/^pr_[A-Za-z0-9_-]{32,}$/.test(value.token || ""))
    throw new Error(
      "连接格式无效，请重新登录或私有导入独立只读配置，不要在对话中粘贴密钥",
    );
  return { apiUrl: origin.origin, token: value.token };
}

export async function readConfigFile(file, { importing = false } = {}) {
  let handle;
  try {
    handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8192)
      throw new Error("连接配置须为小于8KB的普通JSON文件");
    if (
      !importing &&
      process.platform !== "win32" &&
      (stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
    )
      throw new Error(
        "连接配置权限过宽或不属于当前用户；请使用connect.mjs导入为私有配置",
      );
    let value;
    try {
      value = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw new Error("连接配置JSON无效，请重新保存首次连接配置");
    }
    return validateConfig(value);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        "尚未连接Page Review：先运行page-review login；旧版配置可用connect.mjs --from 私有导入",
      );
    if (error.code)
      throw new Error("无法安全读取连接配置，请检查文件类型与访问权限");
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function loadConfig(env = process.env) {
  // Explicit environment credentials remain supported, but never silently mix
  // them with a different saved account's API origin or token.
  if (env.PAGE_REVIEW_TOKEN || env.PAGE_REVIEW_API_URL) {
    if (!env.PAGE_REVIEW_TOKEN || !env.PAGE_REVIEW_API_URL)
      throw new Error(
        "环境连接需要同时设置PAGE_REVIEW_API_URL和PAGE_REVIEW_TOKEN；或移除两者使用已保存连接",
      );
    return validateConfig({
      apiUrl: env.PAGE_REVIEW_API_URL,
      token: env.PAGE_REVIEW_TOKEN,
    });
  }
  return readConfigFile(configPath(env));
}

export async function request(config, resource) {
  let response;
  try {
    response = await fetch(new URL(resource, config.apiUrl), {
      headers: { Authorization: "Bearer " + config.token },
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error(
      "暂时无法访问Page Review，请检查执行机器的网络后重试；未自动重试",
    );
  }
  if (!response.ok) {
    const guidance = {
      401: "连接无效、已过期或已撤销，请运行page-review login重新授权",
      403: "当前连接权限不足，请确认使用AI只读连接",
      404: "资料不存在、已删除或不在当前授权范围",
    };
    const error = new Error(
      "读取失败 " +
        response.status +
        "：" +
        (guidance[response.status] || "接口暂不可用，请稍后手动重试"),
    );
    error.status = response.status;
    throw error;
  }
  return response;
}

export async function verifyReader(config) {
  const identity = await (await request(config, "/v1/me")).json();
  if (identity.access !== "reader")
    throw new Error(
      "拒绝使用写入凭证：请运行page-review login获取独立只读授权",
    );
  return identity;
}
