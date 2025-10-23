# vLLM Minimal Frontend

단일 페이지에서 vLLM REST/OpenAI 호환 API를 테스트할 수 있는 가벼운 Vite 기반 UI 입니다.

## Features

- `/generate`, `/v1/completions`, `/v1/chat/completions` 전환
- `/v1/models` 응답을 바탕으로 한 모델 선택 토글
- 라이트/다크 테마, `<think>` 영역 자동 숨김, 토큰/초 계산
- Raw JSON 응답 토글, 요청 취소 버튼, 간단한 상태 표시

## Getting Started

```bash
npm install
npm run dev
```

기본 API 베이스 URL은 `http://127.0.0.1:8000` 입니다. 다른 주소를 사용하려면 환경 변수로 지정하세요:

```bash
VITE_API_BASE_URL=http://192.168.0.10:8000 npm run dev
```

## Usage Notes

- OpenAI 호환 서버(`python -m vllm.entrypoints.openai.api_server ...`)는 Chat/Completions 모드에서 `model` 값을 필수로 입력해야 합니다.
- Raw REST(`vllm serve --api-type restful`) 모드에서는 `model` 입력이 필요하지 않으며 기본 엔드포인트는 `/generate` 입니다.
- `/v1/models` 호출이 실패하면 직접 모델 이름을 입력해 요청할 수 있습니다.

## Build

```bash
npm run build
```

산출물은 `dist/` 디렉터리에 생성됩니다.
