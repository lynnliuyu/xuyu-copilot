# Triage Labels

技能用五个规范角色来表达 triage 状态。本文件把这些角色映射到本仓库实际使用的标签字符串。

| mattpocock/skills 里的标签 | 本仓库使用的标签 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 需要维护者评估这条 issue |
| `needs-info` | `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已完整描述，可交给无人值守的 agent |
| `ready-for-human` | `ready-for-human` | 需要人来实现 |
| `wontfix` | `wontfix` | 不予处理 |

本仓库使用本地 markdown tracker，标签以 `Status:` 行的形式写在每个 issue 文件里，取值就是上表右侧的字符串。

当某个技能提到一个角色（例如「套上 AFK-ready 的 triage 标签」）时，取本表中对应的字符串。
