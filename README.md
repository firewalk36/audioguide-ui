# Аудиогид: публичный фронтенд

Мобильное веб-приложение для прослушивания аудиоэкскурсий по Нижнему Новгороду. Интерактивная карта показывает точки интереса, пользователь выбирает маршрут или слушает отдельные описания.

## Структура

- **app.js** — точка входа, инициализация, связь компонентов через DOM
- **api.js** — HTTP GET /api/v1/public/guide с кешированием через ETag
- **map.js** — интеграция с Яндекс.Картами 2.1, плейсмарки, маршруты
- **geo.js** — geolocation watch, geofence триггеры, сохранение прослушанных точек
- **player.js** — единый HTMLAudioElement для точек и маршрутов
- **store.js** — минималистичный observable state контейнер
- **dom.js** — безопасное построение DOM, утилиты (нет innerHTML)
- **config.js** — статические параметры (API base, карты, геолокация)

## Развёртывание

**Локально**: `python3 -m http.server 8765`, затем `http://localhost:8765/?demo=1` (демо-данные из `dev/guide.sample.json`)

**Тесты**: `open /tests/geo.test.html`

**API контракт**: `GET /api/v1/public/guide` — routes, points (title, description, lat, lon, trigger_radius_m, audio, image)

**На сервер**: static файлы → `/var/www/guide` via `audioguide-backend/deploy/scripts/deploy.sh guide` (dev/ и tests/ исключаются)

## Конфигурация

- **API base**: `/api/v1`
- **Яндекс.Карты ключ** (`js/config.js`): ограничен на отображение карты; маршрутизация и геокодирование fallback на `yandex.ru/maps`
- **Нет шага сборки**: нативные ES modules

## Примечание

- Модули можно импортировать в Node (тесты, утилиты) — ничего не касается `window`/`document` на уровне импорта
- Дизайн адаптивен: мобильная карта (основной вид), боковая панель для маршрутов и фильтров
