/**
 * 宿主半侧：本插件不需要任何 Host 能力（便签全部存在浏览器 localStorage）。
 * 这一层只负责让 cordis.patch.yml 里的 entry 有一行可加载的插件；
 * 真正的界面在 lib/client.js，由 package.json 的 dsh.client 声明加载。
 * @module dsh-sticky-notes
 */

export const name = 'dsh-sticky-notes'

export const inject = []

export function apply() {
  // 有意留空：没有 Host 侧的服务、命令或路由需要注册。
}
