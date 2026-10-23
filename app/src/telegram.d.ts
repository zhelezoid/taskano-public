// Минимальный набор Telegram WebApp API, который использует Mini App.
export interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  subtitle_text_color?: string;
  accent_text_color?: string;
  destructive_text_color?: string;
  section_separator_color?: string;
}

export type TelegramEvent = 'themeChanged' | 'safeAreaChanged' | 'contentSafeAreaChanged' | 'viewportChanged';

export interface TelegramWebApp {
  initData: string;
  /** Разобранные данные запуска; `start_param` — из ссылки `t.me/<bot>?startapp=…` (без проверки подписи). */
  initDataUnsafe?: { start_param?: string };
  themeParams: TelegramThemeParams;
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  requestFullscreen?(): void;
  /** Отступы системы (Bot API 8.0): вырез и панель Telegram поверх приложения. */
  safeAreaInset?: { top: number; bottom: number; left: number; right: number };
  contentSafeAreaInset?: { top: number; bottom: number; left: number; right: number };
  openTelegramLink(url: string): void;
  openLink?(url: string): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  showConfirm?(message: string, callback: (ok: boolean) => void): void;
  /** Кнопка «Назад» Telegram: ею же приходит системный жест возврата (карточка дела). */
  isVersionAtLeast?: (v: string) => boolean;
  BackButton?: {
    isVisible?: boolean;
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
    offClick(handler: () => void): void;
  };
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  onEvent(event: TelegramEvent, handler: () => void): void;
  offEvent(event: TelegramEvent, handler: () => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}
