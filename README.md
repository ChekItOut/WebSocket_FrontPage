# Longkathon Chat Test

WebSocket(STOMP + SockJS) 기반 실시간 채팅 테스트 페이지입니다.
Spring Boot 백엔드 서버와 연동하여 1:1 채팅을 테스트할 수 있습니다.

## 기술 스택

- **Frontend**: React 19, Create React App
- **WebSocket**: @stomp/stompjs + sockjs-client
- **인증**: JWT (Access Token / Refresh Token) + Google OAuth2

## 주요 기능

- Google OAuth2 로그인 / 로그아웃
- JWT Access Token 자동 갱신 (401 응답 시 Refresh Token으로 재발급)
- REST API를 통한 채팅방 생성 및 입장
- STOMP over SockJS 실시간 메시지 송수신
- WebSocket 연결 상태 표시 (CONNECTED / CONNECTING / DISCONNECTED)
- 수동 WebSocket 재연결 / 종료

## 프로젝트 구조

```
src/
├── index.js            # React 엔트리포인트
├── App.js              # ChatTestPage 렌더링
├── ChatTestPage.js     # 채팅 테스트 페이지 (인증, REST, WebSocket 로직 포함)
├── App.css
└── index.css
```

## 백엔드 연동 스펙

| 항목 | 값 |
|---|---|
| API Base URL | `http://localhost:8080` |
| SockJS Endpoint | `/chat/inbox` |
| STOMP 구독 경로 | `/sub/channel/{chatRoomId}` |
| STOMP 전송 경로 | `/pub/message` |
| 채팅방 생성 API | `POST /v1/chatRoom` |
| 토큰 재발급 API | `POST /api/token` |
| OAuth2 로그인 | `/oauth2/authorization/google` |

## 시작하기

### 사전 요구사항

- Node.js
- 백엔드 서버가 `http://localhost:8080`에서 실행 중이어야 합니다

### 설치 및 실행

```bash
npm install
npm start
```

브라우저에서 [http://localhost:3000](http://localhost:3000)으로 접속합니다.

## 사용 방법

1. **Google Login** 버튼을 클릭하여 로그인합니다.
2. 좌측 패널에서 상대 유저 ID를 입력하고 **입장** 버튼을 클릭합니다.
3. 채팅방이 생성되면 WebSocket이 자동으로 연결됩니다.
4. 하단 입력창에 메시지를 입력하고 Enter 또는 **전송** 버튼을 클릭합니다.
