<p align='center'>
<img src='./build/icon.png' width="150" height="150" alt="SRIBD Office Agent アイコン" />
</p>

<h1 align="center">SRIBD Office Agent - エンタープライズ AI Agent デスクトップクライアント</h1>

<p align="center">SRIBD Office Agent は、ローカルファーストのエンタープライズ向け AI Agent デスクトップクライアントです。オープンソースプロジェクト <a href="https://github.com/ThinkInAIXYZ/deepchat">DeepChat</a>（Apache License 2.0）をベースに構築されています。Tape.systemsの哲学に基づく豊富な Agent 機能に加え、MCP、Skills、ACP、メッセージアプリ向けリモートコントロールをサポートし、ドキュメント認識・アーカイブ、履歴書スクリーニング、オフィス自動化などの SRIBD エンタープライズ拡張機能を備えています。</p>

<p align="center">
  <a href="https://github.com/jacknjzhou/deepchat-project/stargazers"><img src="https://img.shields.io/github/stars/jacknjzhou/deepchat-project" alt="Stars Badge"/></a>
  <a href="https://github.com/jacknjzhou/deepchat-project/network/members"><img src="https://img.shields.io/github/forks/jacknjzhou/deepchat-project" alt="Forks Badge"/></a>
  <a href="https://github.com/jacknjzhou/deepchat-project/pulls"><img src="https://img.shields.io/github/issues-pr/jacknjzhou/deepchat-project" alt="Pull Requests Badge"/></a>
  <a href="https://github.com/jacknjzhou/deepchat-project/issues"><img src="https://img.shields.io/github/issues/jacknjzhou/deepchat-project" alt="Issues Badge"/></a>
  <a href="https://github.com/jacknjzhou/deepchat-project/blob/develop/LICENSE"><img src="https://img.shields.io/github/license/jacknjzhou/deepchat-project" alt="License Badge"/></a>
</p>

<div align="center">
  <a href="./README.zh.md">中文</a> / <a href="./README.md">English</a> / <a href="./README.jp.md">日本語</a>
</div>

## 📑 目次

- [📑 目次](#-目次)
- [🚀 プロジェクト紹介](#-プロジェクト紹介)
- [💡 なぜSRIBD Office Agentを選ぶのか](#-なぜsribd-office-agentを選ぶのか)
- [🔥 主な機能](#-主な機能)
- [🏢 SRIBD エンタープライズ拡張機能](#-sribd-エンタープライズ拡張機能)
- [📼 Tape と Trace](#-tape-と-trace)
- [🧠 Skills サポート](#-skills-サポート)
- [🧩 ACP 連携（Agent Client Protocol）](#-acp-連携agent-client-protocol)
- [📡 リモートコントロール](#-リモートコントロール)
- [🤖 サポートされているモデルプロバイダー](#-サポートされているモデルプロバイダー)
  - [OpenAI/Gemini/Anthropic API形式の任意のモデルプロバイダーと互換性あり](#openaigeminianthropic-api形式の任意のモデルプロバイダーと互換性あり)
- [🔍 ユースケース](#-ユースケース)
- [📦 クイックスタート](#-クイックスタート)
  - [ダウンロードとインストール](#ダウンロードとインストール)
  - [モデルの設定](#モデルの設定)
  - [会話を開始](#会話を開始)
- [💻 開発ガイド](#-開発ガイド)
  - [依存関係のインストール](#依存関係のインストール)
  - [開発を開始](#開発を開始)
  - [ビルド](#ビルド)
- [👥 コミュニティと貢献](#-コミュニティと貢献)
- [📃 ライセンス](#-ライセンス)

## 🚀 プロジェクト紹介

SRIBD Office Agentは、モデル・ツール・Skills・エージェントランタイム・Tape・長時間セッションを1つのデスクトップアプリに統合する、強力なローカルファーストAgentデスクトップクライアントです。OpenAI、Gemini、AnthropicなどのクラウドAPIや、ローカルにデプロイされたOllamaモデルを使用する場合でも、SRIBD Office Agentはスムーズなユーザー体験を提供します。

SRIBD Office AgentのセッションとAgentプロセスはTape.systemsの哲学に基づいています。プロセスを残すことで、コンテキスト、ツール呼び出し、リクエスト、結果を復元・追跡・検査できます。さらに、優れたMCPサポート、インストール可能なSkills、ACP Agent連携、Telegram、Feishu/Lark、QQBot、Discord、WeChat iLinkなどのIMツールからのリモートコントロールを提供します。

SRIBD Office Agentは、オープンソースプロジェクト DeepChat をベースに構築されています。上流コミュニティが築いた素晴らしい基盤に感謝します。

## 💡 なぜSRIBD Office Agentを選ぶのか

他のAIツールと比較して、SRIBD Office Agentは以下のようなユニークな利点を提供します：

- **ローカルファーストAgentデスクトップクライアント**: SRIBD Office Agent、ACP Agent、リモート対応Botを1つのローカルアプリで実行できます
- **Tape.systemsの哲学**: 復元可能なセッション履歴を保持し、リクエストコンテキストとtoken予算を検査できます
- **持ち運べるSkills**: 会話ごとにSkillsをインストール、インポート、エクスポート、有効化し、コードレビュー、文書、フロントエンド、Office/PDFなどに対応できます
- **ネイティブACP連携**: ACP互換のコーディング/タスクエージェントを「モデル」と同じ入口から使用できます
- **優れたMCPサポート**: Resources、Prompts、Tools、複数Transport、inMemoryサービス、ワンクリックインストールに対応します
- **リモート対応ワークフロー**: Telegram、Feishu/Lark、QQBot、Discord、WeChat iLink からSRIBD Office Agentセッションを操作できます
- **統一されたマルチモデル管理**: 主要なクラウドLLMとローカルOllamaモデルを1つのアプリで扱えます
- **プライバシー重視**: ローカルデータストレージとネットワークプロキシのサポートにより、情報漏洩のリスクを軽減します
- **ビジネスフレンドリー**: Apache License 2.0の下でオープンソース化され、商用・個人利用の両方に適しています

## 🔥 主な機能

- 🤖 **ローカルファーストAgentデスクトップクライアント**
  - SRIBD Office Agent、ACP、リモート対応エージェントを1つのモデル選択に近い入口から選択
  - プロジェクトフォルダー、権限モード、ツール出力、復元可能なコンテキストを備えた長時間セッションに対応
- 📼 **Tape と Trace**
  - Session Tapeが構造化された作業履歴を記録し、復元、再開、将来のAgent memoryフローを支えます
  - Traceプレビューでリクエスト番号、プロバイダー/モデル情報、Tape view manifest、含まれるエントリー、token予算を確認できます
- 🧠 **Skills**
  - フォルダー、ZIPファイル、URLからSkillsをインストール可能
  - 会話ごとにSkillsを有効化し、タスク専用の手順、参考資料、任意のスクリプトを読み込み可能
  - Claude Code、Codex、Cursor、Windsurf、GitHub Copilotなどの互換ツールとインポート/エクスポート可能
- 🤝 **ACP（Agent Client Protocol）エージェント連携**
  - ACP互換エージェント（内蔵/カスタムコマンド）を「モデル」として選択可能
  - エージェントが提供する場合、ACP Workspace UI で構造化プラン、ツール呼び出し、ターミナル出力を表示
- 📡 **リモートコントロール**
  - Telegram、Feishu/Lark、QQBot、Discord、WeChat iLink からSRIBD Office Agentセッションを操作可能
  - リモートエンドポイントをセッションに紐づけ、モデル切り替え、保留中の操作対応、生成停止、デスクトップ表示を実行可能
- 🌐 **複数のクラウドLLMプロバイダーサポート**: DeepSeek、OpenAI、Moonshot/Kimi、Grok、Gemini、Anthropicなど
- 🏠 **ローカルモデルデプロイメントサポート**:
  - 包括的な管理機能を備えた統合Ollama
  - コマンドライン操作なしでOllamaモデルのダウンロード、デプロイメント、実行を制御・管理
- 🚀 **豊富で使いやすいチャット機能**
  - 業界最高レベルの [CodeMirror](https://codemirror.net/) を基盤としたコードブロックレンダリングを含む完全なMarkdownレンダリング
  - マルチウィンドウ + マルチタブアーキテクチャで、あらゆる次元でマルチセッション並列動作をサポート。ブラウザのように大規模モデルを使用し、ノンブロッキング体験により優れた効率を実現
  - 多様な結果表示のためのアーティファクトレンダリングをサポート
  - メッセージは複数のバリエーションを生成するためのリトライをサポート。会話は自由にフォーク可能で、常に適切な思考の流れを確保
  - 画像、Mermaidダイアグラム、その他のマルチモーダルコンテンツのレンダリングをサポート。GPT-4o、Gemini、Grokのテキストから画像生成機能をサポート
  - 検索結果などの外部情報ソースをコンテンツ内でハイライト表示
- 🔍 **強力な検索強化機能**
  - 博查搜索、Brave Searchなどの主要な検索APIを組み込み、モデルが検索のタイミングを賢く判断
  - ユーザーのウェブブラウジングをシミュレートすることで、Google、Bing、Baidu、Sogou公式アカウント検索などの主要検索エンジンをサポート
  - あらゆる検索エンジンの読み取りをサポート。検索アシスタントモデルを設定するだけで、内部ネットワーク、APIなしのエンジン、垂直ドメイン検索エンジンなど、様々な情報ソースをモデルに接続可能
- 🔧 **優れたMCP（Model Context Protocol）サポート**
  - Resources / Prompts / Tools の三大コア機能をサポート
  - StreamableHTTP、SSE、StdioなどのTransportに対応
  - 組み込みNode.jsランタイムにより、npx/node系サービスがすぐに利用可能
  - コード実行、Web情報取得、ファイル操作などのinMemoryサービスに対応
  - ツール呼び出し、パラメータ、戻り値を見やすくデバッグ可能
  - DeepLinkによるMCPサービスのワンクリックインストールに対応
- 💻 **マルチプラットフォームサポート**: Windows、macOS、Linux
- 🎨 **美しく使いやすいインターフェース**、ユーザー志向の設計、丁寧なライト/ダークモードテーマ
- 🔗 **豊富なDeepLinkサポート**: リンクを通じて会話を開始し、他のアプリケーションとシームレスに統合。MCPサービスのワンクリックインストールにも対応
- 🚑 **セキュリティ重視の設計**: チャットデータと設定データに暗号化インターフェースとコード難読化機能を備える
- 🛡️ **プライバシー保護**: スクリーン投影の非表示、ネットワークプロキシなどのプライバシー保護方法をサポートし、情報漏洩のリスクを軽減
- 💰 **ビジネスフレンドリー**:
  - オープンソースを採用し、Apache License 2.0ライセンスに基づく、企業利用も安心
  - 企業統合では最小限の設定コード変更のみで予約された暗号化難読化セキュリティ機能を使用可能
  - コード構造が明確で、モデルプロバイダーもMCPサービスも高度に分離されており、最小コストで自由にカスタマイズ可能
  - 合理的なアーキテクチャ、データ相互作用とUI動作の分離により、Electronの機能を十分に活用し、単純なウェブラッパーを拒否、優れたパフォーマンス

## 🏢 SRIBD エンタープライズ拡張機能

本フォークは **SRIBD Office Agent** としてリリースされており、アップストリームの DeepChat 機能に加えて、以下のエンタープライズ向け機能を追加しています：

- 📄 **ドキュメント認識・アーカイブ**
  - ビジュアル抽出テンプレートエディター：請求書プリセットテンプレートに加え、カスタムフィールド・プロンプト・テスト抽出パネルをサポート
  - 複数ファイルの一括認識タスク：同時実行キュー、リアルタイム進捗、失敗タスクのその場再試行
  - ファイルごとのスマートルーティング：PDF テキスト層の直接抽出、スキャンページのビジョンモデル認識、OCR フォールバック
  - フィールド検証と金額クロスチェック、請求書対応の抽出プロンプト
  - アーカイブブラウザー：日付フィルター、ページネーション、詳細編集、ソースファイル対照プレビュー、CSV エクスポート
  - チャットから内蔵エージェントツール経由でドキュメント認識を呼び出し可能
- 🧑‍💼 **履歴書スクリーニングアシスタント**
  - 履歴書ファイルからスクリーニングタスクを作成；テキスト抽出と LLM パイプラインにより、構造化された候補者プロファイルと面接ポイントを自動生成
  - タスク詳細はセクション切り替え表示、履歴書ソースファイルのインラインプレビューに対応
- 🖼️ **画像プロンプトテンプレート**
  - 内蔵の画像生成プロンプトテンプレート。チャット内でスターターカードとポップオーバーパネルからワンクリック適用
- 📊 **PPT Master スキル**
  - PowerPoint プレゼンテーション生成用の内蔵スキル
- 🏢 **オフィス自動化プラグインと百度検索**
  - オフィス自動化 MCP プラグインを内蔵し、百度ウェブ検索を統合
- 🔌 **モデルアクセス強化**
  - `DEEPCHAT_PROVIDER_DB_OFFLINE` による固定オフラインプロバイダーデータベースに対応
  - 同一プロバイダーの複数インスタンス設定と、会話内での拡張モデル選択に対応
- 🌏 **内蔵スキルの中国語ローカライズ**
  - GPT-Image-2、PDF 画像テキスト抽出、ウェブスクレイパーなどのスキルに中国語インターフェースを提供
- ℹ️ **Windows システム情報表示**
  - バージョン情報ページに、現在の Windows ログインユーザーの基本アカウント情報（ユーザー名、ドメイン、ホスト名、ホームディレクトリ、SID）を読み取り専用カードで表示。情報はローカルでのみ読み取られ、一切アップロードされません。macOS/Linux では自動的に非表示になります

## 📼 Tape と Trace

SRIBD Office AgentのSession TapeはTape.systemsの哲学を継承し、エージェント作業を復元可能かつ検査可能にします。Traceプレビューでは、リクエスト番号、プロバイダー/モデル情報、Tape view manifest、含まれる/除外されるコンテキストエントリー、token予算を確認でき、長時間セッションのデバッグと再開が容易になります。

## 🧠 Skills サポート

SRIBD Office Agent Skills は標準の Agent Skills 仕様と互換性のある設計です。Skillにはタスク手順、参考資料、アセット、任意のスクリプトを含めることができ、有効化するとSRIBD Office Agentがその分野の専門アシスタントのように振る舞えます。

Skillsはフォルダー、ZIPファイル、URLからインストールできます。Claude Code、Codex、Cursor、Windsurf、GitHub Copilot、Kiro、Antigravity、OpenCode、Goose、Kilo Code などの互換ツールとのインポート/エクスポートにも対応します。

組み込みSkillsは、生成アート、コードレビュー、DeepChat設定、ドキュメント共同作成、DOCX、フロントエンド設計、git commitメッセージ、インフォグラフィック構文、MCP構築、PDF、PPTX、Skill作成、Web Artifacts、XLSXワークフローをカバーします。

クイックスタート：

1. **設定 → Skills** を開く
2. Skillをインストールまたはインポートする
3. 必要な会話でそのSkillを有効化する

## 🧩 ACP 連携（Agent Client Protocol）

SRIBD Office Agentは [Agent Client Protocol（ACP）](https://agentclientprotocol.com) を内蔵しており、外部のエージェントランタイムをSRIBD Office Agentにネイティブに統合できます。有効化すると、ACPエージェントはモデルセレクターに「モデル」として表示され、SRIBD Office Agent内でコーディング/タスク系エージェントをWorkspace UIと一緒に利用できます。

クイックスタート：

1. **設定 → ACPエージェント** でACPを有効化
2. 内蔵ACPエージェントを有効化するか、ACP互換コマンドを追加
3. モデルセレクターでACPエージェントを選択してセッションを開始

ACP互換のエージェント/クライアント一覧：https://agentclientprotocol.com/overview/clients

## 📡 リモートコントロール

SRIBD Office Agentはメッセージアプリからリモート操作できるため、デスクトップから離れていても同じセッションを継続できます。設定は **設定 → Remote** から行います。

対応チャンネルは Telegram、Feishu/Lark、QQBot、Discord、WeChat iLink です。リモートエンドポイントは1つのSRIBD Office Agentセッションに紐づけられ、リモートチャットから新規セッション作成、最近のセッション一覧と切り替え、生成停止、現在のセッションをデスクトップで開く、保留中の質問や権限リクエストへの回答、モデル切り替え、実行状態の確認ができます。

主なコマンドは `/start`、`/help`、`/pair`、`/new`、`/sessions`、`/use`、`/stop`、`/open`、`/pending`、`/model`、`/status` です。

## 🤖 サポートされているモデルプロバイダー

<table>
  <tr align="center">
    <td>
      <img src="./src/renderer/src/assets/llm-icons/deepseek-color.svg" width="50" height="50" alt="Deepseek Icon"><br/>
      <a href="https://deepseek.com/">Deepseek</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/moonshot.svg" width="50" height="50" alt="Moonshot Icon"><br/>
      <a href="https://moonshot.ai/">Moonshot</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/openai.svg" width="50" height="50" alt="OpenAI Icon"><br/>
      <a href="https://openai.com/">OpenAI</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/gemini-color.svg" width="50" height="50" alt="Gemini Icon"><br/>
      <a href="https://gemini.google.com/">Gemini</a>
    </td>
  </tr>
  <tr align="center">
    <td>
      <img src="./src/renderer/src/assets/llm-icons/ollama.svg" width="50" height="50" alt="Ollama Icon"><br/>
      <a href="https://ollama.com/">Ollama</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/qiniu.svg" width="50" height="50" alt="Qiniu Icon"><br/>
      <a href="https://www.qiniu.com">Qiniu</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/newapi.svg" width="50" height="50" alt="New API Icon"><br/>
      <a href="https://www.newapi.ai/">New API</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/grok.svg" width="50" height="50" alt="Grok Icon"><br/>
      <a href="https://x.ai/">Grok</a>
    </td>
  </tr>
  <tr align="center">
    <td>
      <img src="./src/renderer/src/assets/llm-icons/zhipu-color.svg" width="50" height="50" alt="Zhipu Icon"><br/>
      <a href="https://open.bigmodel.cn/">Zhipu</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/ppio-color.svg" width="50" height="50" alt="PPIO Icon"><br/>
      <a href="https://ppinfra.com/">PPIO</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/minimax-color.svg" width="50" height="50" alt="MiniMax Icon"><br/>
      <a href="https://platform.minimaxi.com/">MiniMax</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/fireworks-color.svg" width="50" height="50" alt="Fireworks Icon"><br/>
      <a href="https://fireworks.ai/">Fireworks</a>
    </td>
  </tr>
  <tr align="center">
    <td>
      <img src="./src/renderer/src/assets/llm-icons/aihubmix.png" width="50" height="50" alt="AIHubMix Icon"><br/>
      <a href="https://aihubmix.com/">AIHubMix</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/doubao-color.svg" width="50" height="50" alt="Doubao Icon"><br/>
      <a href="https://console.volcengine.com/ark/">Doubao</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/alibabacloud-color.svg" width="50" height="50" alt="DashScope Icon"><br/>
      <a href="https://www.aliyun.com/product/bailian">DashScope</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/groq.svg" width="50" height="50" alt="Groq Icon"><br/>
      <a href="https://groq.com/">Groq</a>
    </td>
  </tr>
  <tr align="center">
    <td>
      <img src="./src/renderer/src/assets/llm-icons/jiekou-color.svg" width="50" height="50" alt="JieKou.AI Icon"><br/>
      <a href="https://jiekou.ai?utm_source=github_deepchat">JieKou.AI</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/zenmux-color.svg" width="50" height="50" alt="ZenMux Icon"><br/>
      <a href="https://zenmux.ai/">ZenMux</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/github.svg" width="50" height="50" alt="GitHub Models Icon"><br/>
      <a href="https://github.com/marketplace/models">GitHub Models</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/lmstudio.svg" width="50" height="50" alt="LM Studio Icon"><br/>
      <a href="https://lmstudio.ai/docs/app">LM Studio</a>
    </td>
  </tr>
  <tr align="center">
    <td>
      <img src="./src/renderer/src/assets/llm-icons/hunyuan-color.svg" width="50" height="50" alt="Hunyuan Icon"><br/>
      <a href="https://cloud.tencent.com/product/hunyuan">Hunyuan</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/302ai.svg" width="50" height="50" alt="302.AI Icon"><br/>
      <a href="https://302ai.cn/">302.AI</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/together-color.svg" width="50" height="50" alt="Together Icon"><br/>
      <a href="https://www.together.ai/">Together</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/poe-color.svg" width="50" height="50" alt="Poe Icon"><br/>
      <a href="https://poe.com/">Poe</a>
    </td>
  </tr>
  <tr align="center">
    <td>
      <img src="./src/renderer/src/assets/llm-icons/vercel.svg" width="50" height="50" alt="Vercel AI Gateway Icon"><br/>
      <a href="https://vercel.com/ai">Vercel AI Gateway</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/openrouter.svg" width="50" height="50" alt="OpenRouter Icon"><br/>
      <a href="https://openrouter.ai/">OpenRouter</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/azure-color.svg" width="50" height="50" alt="Azure OpenAI Icon"><br/>
      <a href="https://azure.microsoft.com/en-us/products/ai-services/openai-service">Azure OpenAI</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/tokenflux-color.svg" width="50" height="50" alt="TokenFlux Icon"><br/>
      <a href="https://tokenflux.ai/">TokenFlux</a>
    </td>
  </tr>
  <tr align="center">
    <td>
      <img src="./src/renderer/src/assets/llm-icons/burncloud-color.svg" width="50" height="50" alt="BurnCloud Icon"><br/>
      <a href="https://www.burncloud.com/">BurnCloud</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/openai.svg" width="50" height="50" alt="OpenAI Responses Icon"><br/>
      <a href="https://openai.com/">OpenAI Responses</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/cherryin-color.png" width="50" height="50" alt="CherryIn Icon"><br/>
      <a href="https://open.cherryin.ai/console">CherryIn</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/modelscope-color.svg" width="50" height="50" alt="ModelScope Icon"><br/>
      <a href="https://modelscope.cn/">ModelScope</a>
    </td>
  </tr>
  <tr align="center">
    <td>
      <img src="./src/renderer/src/assets/llm-icons/aws-bedrock.svg" width="50" height="50" alt="AWS Bedrock Icon"><br/>
      <a href="https://aws.amazon.com/bedrock/">AWS Bedrock</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/voiceai.svg" width="50" height="50" alt="Voice.ai Icon"><br/>
      <a href="https://voice.ai/">Voice.ai</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/vertexai-color.svg" width="50" height="50" alt="Vertex AI Icon"><br/>
      <a href="https://cloud.google.com/vertex-ai">Vertex AI</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/githubcopilot.svg" width="50" height="50" alt="GitHub Copilot Icon"><br/>
      <a href="https://github.com/features/copilot">GitHub Copilot</a>
    </td>
  </tr>
  <tr align="center">
    <td>
      <img src="./src/renderer/src/assets/llm-icons/xiaomi.png" width="50" height="50" alt="Xiaomi Icon"><br/>
      <a href="https://platform.xiaomimimo.com/#/docs/quick-start/first-api-call">Xiaomi</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/o3-fan.png" width="50" height="50" alt="o3.fan Icon"><br/>
      <a href="https://o3.fan">o3.fan</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/novitaai.svg" width="50" height="50" alt="Novita AI Icon"><br/>
      <a href="https://novita.ai/">Novita AI</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/astraflow.png" width="50" height="50" alt="Astraflow Icon"><br/>
      <a href="https://astraflow.ucloud.cn/">Astraflow</a>
    </td>
  </tr>
  <tr align="center">
    <td>
      <img src="./src/renderer/src/assets/llm-icons/anthropic.svg" width="50" height="50" alt="Anthropic Icon"><br/>
      <a href="https://www.anthropic.com/">Anthropic</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/siliconcloud-color.svg" width="50" height="50" alt="SiliconFlow Icon"><br/>
      <a href="https://www.siliconflow.cn/">SiliconFlow</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/orcarouter.svg" width="50" height="50" alt="OrcaRouter Icon"><br/>
      <a href="https://www.orcarouter.ai/">OrcaRouter</a>
    </td>
    <td>
      <img src="./src/renderer/src/assets/llm-icons/synthorai.svg" width="50" height="50" alt="Synthorai Icon"><br/>
      <a href="https://synthorai.io/">Synthorai</a>
    </td>
  </tr>

</table>

### OpenAI/Gemini/Anthropic API形式の任意のモデルプロバイダーと互換性あり

## 🔍 ユースケース

SRIBD Office Agentは様々なAIアプリケーションシナリオに適しています：

- **日常アシスタント**: 質問への回答、提案の提供、文章作成の支援
- **開発支援**: コード生成、デバッグ、技術的問題の解決
- **学習ツール**: 概念の説明、知識の探求、学習ガイダンス
- **コンテンツ作成**: コピーライティング、クリエイティブなインスピレーション、コンテンツの最適化
- **データ分析**: データの解釈、チャート生成、レポート作成

## 📦 クイックスタート

### ダウンロードとインストール

[GitHub Releases](https://github.com/jacknjzhou/deepchat-project/releases)ページから、お使いのシステム用の最新バージョンをダウンロードしてください：

- Windows: `.exe`インストールファイル
- macOS: `.dmg`インストールファイル
- Linux: `.AppImage`または`.deb`インストールファイル

内部分発チャネルは SRIBD チームが管理しています。内部ダウンロードリンクについては、メンテナーまでお問い合わせください。

### モデルの設定

1. SRIBD Office Agentアプリケーションを起動
2. 設定アイコンをクリック
3. "モデルプロバイダー"タブを選択
4. APIキーを追加するか、ローカルOllamaを設定

### 会話を開始

1. "+"ボタンをクリックして新しい会話を作成
2. 使用したいモデルを選択
3. AIアシスタントとの対話を開始

## 💻 開発ガイド

[貢献ガイドライン](./CONTRIBUTING.md)をお読みください。

WindowsとLinuxはGitHub Actionによってパッケージングされます。
Mac関連の署名とパッケージングについては、[Mac リリースガイド](https://github.com/ThinkInAIXYZ/deepchat/wiki/Mac-Release-Guide)を参照してください。

### 依存関係のインストール

```bash
$ pnpm install
$ pnpm run installRuntime
# エラーが出た場合: No module named 'distutils'
$ pip install setuptools
```

* For Windows: 非管理者ユーザーがシンボリックリンクやハードリンクを作成できるようにするには、設定で「開発者モード」を有効にするか、管理者アカウントを使用してください。それ以外の場合、pnpm の操作は失敗します。

### 開発を開始

```bash
$ pnpm run dev
```

### ビルド

```bash
# Windowsの場合
$ pnpm run build:win

# macOSの場合
$ pnpm run build:mac

# Linuxの場合
$ pnpm run build:linux

# アーキテクチャを指定してパッケージング
$ pnpm run build:win:x64
$ pnpm run build:win:arm64
$ pnpm run build:mac:x64
$ pnpm run build:mac:arm64
$ pnpm run build:linux:x64
$ pnpm run build:linux:arm64
```

## 👥 コミュニティと貢献

SRIBD Office Agentは SRIBD チームによってメンテナンスされており、様々な形での貢献を歓迎します：

- 🐛 [問題を報告する](https://github.com/jacknjzhou/deepchat-project/issues)
- 💡 [機能の提案を提出する](https://github.com/jacknjzhou/deepchat-project/issues)
- 🔧 [コードの改善を提出する](https://github.com/jacknjzhou/deepchat-project/pulls)
- 🌍 [翻訳を手伝う](./src/renderer/src/i18n)

プロジェクトへの参加方法について詳しく知るには、[貢献ガイドライン](./CONTRIBUTING.md)をご確認ください。

## 🙏🏻 謝辞

このプロジェクトは、オープンソースプロジェクト [DeepChat](https://github.com/ThinkInAIXYZ/deepchat) をベースに構築されており、以下の素晴らしいライブラリとプロジェクトの支援を受けています：

- [Vue](https://vuejs.org/)
- [Electron](https://www.electronjs.org/)
- [Electron-Vite](https://electron-vite.org/)
- [oxlint](https://github.com/oxc-project/oxc)
- [Bub](https://github.com/bubbuild/bub)。その tape model は session tape 設計に着想を与えました。基盤となる tape アーキテクチャに関心がある方は [tape.systems](https://tape.systems/) をご覧ください。

## 📃 ライセンス

[L