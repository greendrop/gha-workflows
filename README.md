# gha-workflows

複数のリポジトリで共通に使う GitHub Actions の reusable workflow（`workflow_call`）を管理するリポジトリ。

- public リポジトリだが、GitHub Marketplace には公開しない（reusable workflow は Marketplace の対象外）
- リポジトリの設定は [github-terraform](https://github.com/greendrop/github-terraform) で管理している

## ワークフロー

| ワークフロー | 内容 |
|---|---|
| [`secret-scan.yml`](.github/workflows/secret-scan.yml) | betterleaks で PR の差分コミットから秘密情報を検出する |

`repo-` で始まるワークフローは、このリポジトリ自身の CI・リリース用（呼び出し側からは使わない）。

## 使い方

呼び出し側のリポジトリで、コミット SHA で固定してバージョンをコメントに書く（Renovate の github-actions マネージャーが更新する）。

```yaml
on:
  pull_request:

jobs:
  secret-scan:
    permissions:
      contents: read
    uses: greendrop/gha-workflows/.github/workflows/secret-scan.yml@<sha> # vX.Y.Z
```

- 呼び出し側のジョブで付けた `permissions` が上限になる。reusable workflow の中のジョブはその範囲で権限を絞る
- secrets は `secrets: inherit` ではなく、必要なものだけを明示的に渡す
- チェック名は「呼び出し側のジョブ名 / reusable workflow のジョブ名」（例: `secret-scan / secret-scan`）になる。ruleset の必須チェックはこの名前で指定する

## バージョン管理

リポジトリ全体で 1 つのセマンティックバージョン（`vX.Y.Z`）を [release-please](https://github.com/googleapis/release-please) で管理する。

- PR は squash merge だけで、PR タイトルがコミットメッセージになる。PR タイトルは Conventional Commits の形式にする（`repo-pr-title-lint` でチェック）
  - `fix: ...` → パッチ、`feat: ...` → マイナー、`feat!: ...` → メジャー（1.0.0 未満の間はマイナー）
  - `chore:` / `docs:` / `ci:` などはリリースしない
  - scope にワークフロー名を書くと、どのワークフローの変更か CHANGELOG で分かる（例: `feat(secret-scan): ...`）
- main に push されると release-please がリリース PR を作成・更新する。リリース PR をマージすると、タグと GitHub Release が作られる
- Renovate による GitHub Actions の更新は、呼び出し側に届けるため `fix(deps)` としてリリースする

## reusable workflow を追加するとき

- `.github/workflows/<name>.yml` に `on: workflow_call` だけのワークフローとして作る（reusable workflow はサブディレクトリに置けない）
- 先頭のコメントに、内容・呼び出し例・必要な設定（inputs / secrets / 呼び出し側に必要なもの）を書く
- 設定値は `vars` を直接読まずに `inputs` で受け取り、secrets は `secrets:` で宣言する
- このリポジトリでも使うなら、`repo-<name>.yml` から `uses: ./.github/workflows/<name>.yml` で呼び出して動作を確認する
- 「ワークフロー」の表に追加する

## 開発

ツール（actionlint・ghalint・zizmor・yamlfmt・betterleaks・lefthook）は [mise](https://mise.jdx.dev/) でバージョンを固定している。CI も同じ `mise.toml` / `mise.lock` を使う。

```bash
# lefthook install も自動実行される
mise install
```

| チェック | 手元での実行 |
|---|---|
| GitHub Actions の lint | `actionlint -color`、`ghalint run`、`zizmor --gh-token "$(gh auth token)" .` |
| YAML の書式 | `yamlfmt -lint .`（`yamlfmt .` で修正） |
| 秘密情報のスキャン | lefthook の pre-commit フックがコミット前に staged の変更をチェックする |
