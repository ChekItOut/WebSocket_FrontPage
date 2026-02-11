import React, { useEffect, useMemo, useRef, useState } from "react";
import SockJS from "sockjs-client";
import { Client } from "@stomp/stompjs";

const API_BASE = "http://localhost:8080";
const WS_SOCKJS_URL = `${API_BASE}/chat/inbox`;
const SUB_PREFIX = "/sub";
const PUB_PREFIX = "/pub";

// ===================== Cookie/Token Utils =====================
function getCookie(key) {
  let result = null;
  const cookie = document.cookie.split(";");
  cookie.some(function (item) {
    item = item.replace(" ", "");
    const dic = item.split("=");
    if (key === dic[0]) {
      result = dic[1];
      return true;
    }
    return false;
  });
  return result;
}

function deleteCookie(name) {
  document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:01 GMT; path=/;";
}

async function reissueAccessTokenFromCookie() {
  const refreshToken = getCookie("refresh_token");
  if (!refreshToken) return null;

  const res = await fetch(`${API_BASE}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) return null;

  const data = await res.json();
  if (!data?.accessToken) return null;

  localStorage.setItem("access_token", data.accessToken);
  return data.accessToken;
}

async function httpRequest(method, url, body = null) {
  const fullUrl = url.startsWith("http")
    ? url
    : `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`;

  const token = localStorage.getItem("access_token");

  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const options = {
    method,
    headers,
    credentials: "include",
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(fullUrl, options);
  if (res.ok) return res;

  if (res.status === 401) {
    const newAccess = await reissueAccessTokenFromCookie();
    if (newAccess) return httpRequest(method, url, body);

    localStorage.removeItem("access_token");
    throw new Error("UNAUTHORIZED");
  }

  throw new Error(`Request failed: ${res.status}`);
}

// JWT payload decode (의존성 없이)
function parseJwtPayload(token) {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

// ===================== Component =====================
export default function ChatTestPage() {
  const [authReady, setAuthReady] = useState(false);
  const [me, setMe] = useState(null);

  const [otherUserId, setOtherUserId] = useState("");
  const [room, setRoom] = useState(null);

  const [messageText, setMessageText] = useState("");
  const [messages, setMessages] = useState([]);

  const [wsStatus, setWsStatus] = useState("DISCONNECTED");
  const stompRef = useRef(null);
  const subRef = useRef(null);

  const bottomRef = useRef(null);

  const accessToken = useMemo(() => localStorage.getItem("access_token"), [authReady]);

  // ---- 1) 초기화: URL token 처리 + refresh로 accessToken 확보 ----
  useEffect(() => {
    const init = async () => {
      const params = new URLSearchParams(window.location.search);
      const urlToken = params.get("token");
      if (urlToken) {
        localStorage.setItem("access_token", urlToken);
        window.history.replaceState({}, document.title, window.location.pathname);
      }

      if (!localStorage.getItem("access_token")) {
        await reissueAccessTokenFromCookie();
      }

      const payload = parseJwtPayload(localStorage.getItem("access_token"));
      setMe({
        userId: payload?.userId,           // ✅ 숫자
        email: payload?.email ?? payload?.sub,
        nickname: payload?.nickname,
      });

      setAuthReady(true);
    };

    init();
  }, []);

  // 메시지 추가될 때 스크롤 아래로
  useEffect(() => {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleGoogleLogin = () => {
    window.location.href = `${API_BASE}/oauth2/authorization/google`;
  };

  const disconnectWs = () => {
    if (subRef.current) {
      subRef.current.unsubscribe();
      subRef.current = null;
    }
    if (stompRef.current) {
      stompRef.current.deactivate();
      stompRef.current = null;
    }
    setWsStatus("DISCONNECTED");
  };

  const handleLogout = async () => {
    // 1) WS 먼저 끊기 (자동 재연결 방지)
  disconnectWs();

  // 2) 서버 refresh 폐기 (재발급 로직 없이)
  try {
    await fetch(`${API_BASE}/api/refresh-token`, {
      method: "DELETE",
      credentials: "include",
    });
  } catch {}

  // 3) 클라이언트 정리
  localStorage.removeItem("access_token");
  // refresh_token이 HttpOnly면 이건 의미 없을 수 있음 (서버 만료가 핵심)
  deleteCookie("refresh_token");

  setMe(null);
  setRoom(null);
  setMessages([]);
  setAuthReady((v) => !v);
  };

  // ---- 2) 채팅방 생성/조회 (REST) ----
  const createOrEnterRoom = async () => {
    if (!otherUserId.trim()) {
      alert("상대 유저 ID를 입력하세요.");
      return;
    }

    try {
      const res = await httpRequest("POST", "/v1/chatRoom", { sellerId: Number(otherUserId) });
      const data = await res.json();

      setRoom(data);
      setMessages(data.messages || []);

      await connectAndSubscribe(data.chatRoomId);
    } catch (e) {
      if (e?.message === "UNAUTHORIZED") {
        alert("로그인이 만료되었습니다. 다시 로그인 해주세요.");
      } else {
        alert(`채팅방 생성 실패: ${String(e?.message || e)}`);
      }
    }
  };

  // ---- 3) WebSocket(STOMP) 연결/구독 ----
  const onMessage = (msg) => {
    try {
      const payload = JSON.parse(msg.body);
      setMessages((prev) => [...prev, payload]);
    } catch (e) {
      console.warn("Invalid message:", msg.body);
    }
  };

  const connectAndSubscribe = async (chatRoomId) => {
    const ensureToken = async () => {
      let token = localStorage.getItem("access_token");
      if (!token) token = await reissueAccessTokenFromCookie();
      return token;
    };

    const token = await ensureToken();
    if (!token) {
      alert("AccessToken이 없습니다. 로그인부터 해주세요.");
      return;
    }

    // 이미 연결돼 있으면 구독만 갈아끼우기
    if (stompRef.current && stompRef.current.connected) {
      if (subRef.current) subRef.current.unsubscribe();
      subRef.current = stompRef.current.subscribe(`${SUB_PREFIX}/channel/${chatRoomId}`, onMessage);
      return;
    }

    setWsStatus("CONNECTING");

    const client = new Client({
      webSocketFactory: () => new SockJS(WS_SOCKJS_URL),
      connectHeaders: { Authorization: `Bearer ${token}` },

      reconnectDelay: 3000,
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,

      onConnect: () => {
        setWsStatus("CONNECTED");
        if (subRef.current) subRef.current.unsubscribe();
        subRef.current = client.subscribe(`${SUB_PREFIX}/channel/${chatRoomId}`, onMessage);
      },

      onStompError: async (frame) => {
        console.error("STOMP error:", frame.headers["message"], frame.body);
        const newAccess = await reissueAccessTokenFromCookie();
        if (newAccess) {
          client.deactivate();
          setTimeout(() => connectAndSubscribe(chatRoomId), 300);
        } else {
          setWsStatus("DISCONNECTED");
          alert("WebSocket 인증 실패. 다시 로그인 해주세요.");
        }
      },

      onWebSocketClose: () => {
        setWsStatus("DISCONNECTED");
      },
    });

    stompRef.current = client;
    client.activate();
  };

  // ---- 4) 메시지 전송 (STOMP SEND) ----
  const sendMessage = async () => {
    if (!room?.chatRoomId) {
      alert("먼저 채팅방에 입장하세요.");
      return;
    }
    if (!messageText.trim()) return;

    const client = stompRef.current;
    if (!client || !client.connected) {
      alert("WebSocket이 연결되지 않았습니다.");
      return;
    }

    client.publish({
      destination: `${PUB_PREFIX}/message`,
      body: JSON.stringify({
        chatRoomId: room.chatRoomId,
        content: messageText,
      }),
    });

    setMessageText("");
  };

  const loggedIn = !!accessToken;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#fff", display: "flex", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 1100, background: "rgba(24,24,27,0.6)", border: "1px solid #27272a", borderRadius: 16, overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: 16, borderBottom: "1px solid #27272a" }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Longkathon Chat Test</div>
            <div style={{ fontSize: 12, color: "#a1a1aa" }}>
              REST: JWT 자동 첨부 + 401 시 refresh 재발급 / WS: CONNECT에 Authorization(Bearer) 필요
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, padding: "4px 8px", borderRadius: 999, border: "1px solid #3f3f46", color: wsStatus === "CONNECTED" ? "#6ee7b7" : wsStatus === "CONNECTING" ? "#fbbf24" : "#a1a1aa" }}>
              WS: {wsStatus}
            </span>
            {!loggedIn ? (
              <button onClick={handleGoogleLogin} style={{ padding: "10px 14px", borderRadius: 12, border: "none", fontWeight: 700 }}>
                Google Login
              </button>
            ) : (
              <button onClick={handleLogout} style={{ padding: "10px 14px", borderRadius: 12, border: "1px solid #3f3f46", background: "#18181b", color: "#fff" }}>
                Logout
              </button>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr" }}>
          <div style={{ padding: 16, borderRight: "1px solid #27272a" }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>내 정보(토큰 payload)</div>
            <div style={{ fontSize: 12, background: "rgba(0,0,0,0.2)", border: "1px solid #27272a", borderRadius: 12, padding: 12, lineHeight: 1.6 }}>
              <div>loggedIn: {String(loggedIn)}</div>
              <div>userId(sub): {me?.userId || "-"}</div>
              <div>email: {me?.email || "-"}</div>
              <div>nickname: {me?.nickname || "-"}</div>
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>상대 유저 ID 입력</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={otherUserId}
                  onChange={(e) => setOtherUserId(e.target.value)}
                  placeholder="예) 12"
                  style={{ flex: 1, padding: 10, borderRadius: 12, border: "1px solid #27272a", background: "rgba(0,0,0,0.2)", color: "#fff" }}
                />
                <button
                  onClick={createOrEnterRoom}
                  disabled={!loggedIn}
                  style={{ padding: "10px 14px", borderRadius: 12, fontWeight: 800, border: "none", background: "#10b981", color: "#0a0a0a", opacity: loggedIn ? 1 : 0.4 }}
                >
                  입장
                </button>
              </div>

              {room && (
                <div style={{ marginTop: 12, fontSize: 12, background: "rgba(0,0,0,0.2)", border: "1px solid #27272a", borderRadius: 12, padding: 12, lineHeight: 1.6 }}>
                  <div>chatRoomId: {room.chatRoomId}</div>
                  <div>userId: {room.userId}</div>
                  <div>sellerId: {room.sellerId}</div>
                </div>
              )}

              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <button
                  onClick={() => room?.chatRoomId && connectAndSubscribe(room.chatRoomId)}
                  disabled={!room?.chatRoomId || !loggedIn}
                  style={{ flex: 1, padding: 10, borderRadius: 12, border: "1px solid #3f3f46", background: "#18181b", color: "#fff", opacity: room?.chatRoomId && loggedIn ? 1 : 0.4 }}
                >
                  WS 재연결
                </button>
                <button
                  onClick={disconnectWs}
                  style={{ flex: 1, padding: 10, borderRadius: 12, border: "1px solid #3f3f46", background: "#18181b", color: "#fff" }}
                >
                  WS 종료
                </button>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", minHeight: 560 }}>
            <div style={{ flex: 1, padding: 16, overflow: "auto" }}>
              {messages.length === 0 ? (
                <div style={{ color: "#a1a1aa" }}>메시지가 없습니다. 입장 후 메시지를 보내보세요.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {messages.map((m, idx) => {
                    const mine = me?.userId && String(m.senderId) === String(me.userId);
                    return (
                      <div key={idx} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}>
                        <div style={{ maxWidth: "80%", borderRadius: 16, padding: "10px 12px", border: `1px solid ${mine ? "rgba(16,185,129,0.4)" : "#27272a"}`, background: mine ? "rgba(16,185,129,0.15)" : "rgba(0,0,0,0.2)" }}>
                          <div style={{ fontSize: 12, color: "#a1a1aa", marginBottom: 6 }}>
                            {m.nickname ? m.nickname : `senderId:${m.senderId ?? "?"}`}
                            {m.createdAt ? ` · ${m.createdAt}` : ""}
                          </div>
                          <div style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>{m.content}</div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={bottomRef} />
                </div>
              )}
            </div>

            <div style={{ padding: 12, borderTop: "1px solid #27272a", display: "flex", gap: 8 }}>
              <input
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                placeholder="메시지를 입력하고 Enter"
                disabled={!room?.chatRoomId || wsStatus !== "CONNECTED"}
                style={{ flex: 1, padding: 12, borderRadius: 12, border: "1px solid #27272a", background: "rgba(0,0,0,0.2)", color: "#fff", opacity: !room?.chatRoomId || wsStatus !== "CONNECTED" ? 0.5 : 1 }}
              />
              <button
                onClick={sendMessage}
                disabled={!room?.chatRoomId || wsStatus !== "CONNECTED"}
                style={{ padding: "12px 16px", borderRadius: 12, fontWeight: 800, border: "none", opacity: !room?.chatRoomId || wsStatus !== "CONNECTED" ? 0.4 : 1 }}
              >
                전송
              </button>
            </div>
          </div>
        </div>

        <div style={{ padding: 12, borderTop: "1px solid #27272a", fontSize: 12, color: "#a1a1aa" }}>
          ✅ 구독: <b>{SUB_PREFIX}/channel/{"{chatRoomId}"}</b> · 전송: <b>{PUB_PREFIX}/message</b> · SockJS: <b>/chat/inbox</b>
        </div>
      </div>
    </div>
  );
}
