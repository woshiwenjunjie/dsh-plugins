/**
 * 宿主半侧：不需要 Host 能力时保持空插件，只保证 cordis.patch.yml 里的 entry 能加载。
 * 真需要 Host 能力（文件、命令、路由）时，在这里 apply(ctx) 里注册。
 * @module dsh-my-plugin
 */

export const name = 'dsh-my-plugin'

export const inject = []

export function apply() {
  // 有意留空。
}
