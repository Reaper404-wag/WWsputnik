# SPUTNIK - Веб-платформа мониторинга спутников

<div align="center">

**Прототип онлайн-сервиса для визуализации спутников и анализа орбитальных данных на основе TLE**

*Хакатон РНИИРС | ФГУП «Ростовский-на-Дону НИИИРС»*

</div>

---

## Демо

**Сайт:** [wwsputnik.ru](https://wwsputnik.ru) (к сожалению уже не работает)

---

## Возможности

### Визуализация

| Функция | Описание |
|---------|----------|
| **3D-глобус** | Three.js — реалистичная Земля с дневной/ночной стороной, облаками, огнями городов |
| **2D-карта** | Leaflet.js — тёмная тема, границы стран, маркеры спутников |
| **Переключение 3D/2D** | Мгновенный переход через панель управления |
| **10 000+ спутников** | Одновременная визуализация всех группировок в реальном времени |
| **Трек орбиты** | Прошлая и будущая траектория (1.5 витка) |
| **Линии высоты** | Визуализация положения спутника в пространстве |

### Орбитальные расчёты

| Функция | Описание |
|---------|----------|
| **SGP4-пропагация** | Клиентский расчёт через satellite.js — плавная анимация ~30 FPS |
| **Карточка спутника** | Высота, период, наклонение, RAAN, эксцентриситет, скорость, TLE |
| **Прогноз пролётов** | Ближайшие пролёты над любой точкой (клик по карте) |
| **Зоны покрытия** | Рабочая зона (15°) и геометрическая видимость (0°) |
| **Соты связи** | Гексагональная сетка плотности покрытия |

### Фильтрация и группировка

| Фильтр | Опции |
|--------|-------|
| **Группы** | Станции, Военные, Метео, ДЗЗ, Starlink, OneWeb, Пользовательские |
| **Тип орбиты** | LEO / MEO / GEO / HEO |
| **Высота** | Диапазон в км (двойной слайдер) |
| **Оболочки Starlink** | Shell 1–5, Polar, SSO, Raising |
| **Лимит Starlink** | Слайдер с шагом 500 (оптимизация производительности) |
| **Страна/оператор** | США, Россия, Китай, Индия, ESA, Япония и др. |
| **Избранное** | Персональный список отслеживаемых спутников |
| **Поиск** | По названию или NORAD ID |

### Таймлайн и симуляция

- Воспроизведение / пауза
- Скорость: 0.5x, 1x, 2x, 5x, 10x
- Слайдер перемотки (-1ч ... +1ч)
- Отображение текущего времени симуляции

### Командная работа

| Функция | Описание |
|---------|----------|
| **Авторизация** | Регистрация, вход, JWT-токены |
| **3 роли** | Пользователь, Руководитель, Администратор |
| **Админ-панель** | Управление пользователями, назначение ролей |
| **Панель руководителя** | Управление командой, логи активности |
| **Чат** | Командный чат с @упоминаниями спутников |

### Адаптивность

- Мобильная версия (2x масштаб UI, тач-управление)
- Десктоп (мышь, колёсико, клавиатура)

---

## Архитектура

```
┌──────────────────────────────────────────────────────┐
│                    Frontend                           │
│  earth_visualizer.html + js/app.js + css/style.css   │
│  Three.js (3D) │ Leaflet (2D) │ satellite.js (SGP4)  │
└──────────────────────┬───────────────────────────────┘
                       │ REST API (/api)
┌──────────────────────▼───────────────────────────────┐
│                    Backend                            │
│              FastAPI + Uvicorn                        │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐            │
│  │ Satellites│ │   Auth   │ │   Chat    │            │
│  │  Router   │ │  Router  │ │  Router   │            │
│  └────┬─────┘ └────┬─────┘ └─────┬─────┘            │
│       │            │             │                    │
│  ┌────▼────────────▼─────────────▼─────┐             │
│  │         SQLAlchemy ORM              │             │
│  │    SQLite (sputnik.db)              │             │
│  └─────────────────────────────────────┘             │
│                                                       │
│  ┌─────────────────────────────────────┐             │
│  │  TLE Updater (Celestrak, авто)      │             │
│  │  SGP4 Service (Skyfield)            │             │
│  │  Pass Service (прогноз пролётов)    │             │
│  └─────────────────────────────────────┘             │
└──────────────────────────────────────────────────────┘
```

---

## Стек технологий

### Backend
- **Python 3.12** + **FastAPI** — REST API
- **SQLAlchemy 2.0** — ORM (SQLite)
- **Skyfield** — серверные орбитальные расчёты
- **APScheduler** — автообновление TLE
- **python-jose** + **passlib** — JWT-авторизация

### Frontend
- **Vanilla JS** (ES Modules) — без фреймворков
- **Three.js** — 3D-визуализация с GLSL-шейдерами
- **Leaflet.js** — 2D-карта
- **satellite.js** — клиентская SGP4-пропагация
- **Turf.js** — геопространственные расчёты

### Инфраструктура
- **Nginx** — reverse proxy + статика
- **Certbot** — SSL (Let's Encrypt)
- **systemd** — управление сервисом
- **Ubuntu 24.04** — сервер

---

## Быстрый старт (локально)

### 1. Клонирование

```bash
git clone https://github.com/Reaper404-wag/sputnik.git
cd sputnik
```

### 2. Backend

```bash
python3 -m venv venv
source venv/bin/activate        # Linux/macOS
# venv\Scripts\activate         # Windows

pip install -r backend/requirements.txt
```

Создайте `backend/.env`:
```env
SECRET_KEY=your-secret-key
DATABASE_URL=sqlite:///./sputnik.db
```

Запуск:
```bash
uvicorn backend.main:app --host 0.0.0.0 --port 8003
```

При первом запуске автоматически:
- Создаётся БД и таблицы
- Загружаются TLE-данные с Celestrak (~10 000 спутников)
- Создаётся пользователь `admin` / `admin`

### 3. Frontend

```bash
cd frontend
python3 -m http.server 5500
```

Откройте: **http://localhost:5500/earth_visualizer.html**

---

## Развёртывание на сервере

### 1. Подготовка

```bash
apt update && apt install -y python3-pip python3-venv nginx certbot python3-certbot-nginx
```

### 2. Проект

```bash
cd /opt
git clone https://github.com/Reaper404-wag/sputnik.git
cd sputnik
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
```

### 3. Systemd-сервис

```bash
cat > /etc/systemd/system/sputnik.service << 'EOF'
[Unit]
Description=Sputnik Backend (FastAPI/Uvicorn)
After=network.target

[Service]
WorkingDirectory=/opt/sputnik
ExecStart=/opt/sputnik/venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8003 --workers 2
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload && systemctl enable --now sputnik
```

### 4. Nginx

```bash
cat > /etc/nginx/sites-available/sputnik << 'EOF'
server {
    server_name your-domain.ru;
    root /opt/sputnik/frontend;
    index earth_visualizer.html;

    location / {
        try_files $uri $uri/ /earth_visualizer.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8003/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
}
EOF

ln -sf /etc/nginx/sites-available/sputnik /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
```

### 5. SSL

```bash
certbot --nginx -d your-domain.ru
```

---

## API

Swagger UI доступен по адресу `/docs` (бэкенд).

### Основные эндпоинты

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/satellites/` | Список спутников (пагинация, фильтры) |
| `GET` | `/satellites/tle-data` | TLE-данные по группе |
| `GET` | `/satellites/{norad_id}` | Детальная информация |
| `GET` | `/satellites/{norad_id}/track` | Орбитальный трек |
| `GET` | `/passes/predict` | Прогноз пролётов над точкой |
| `POST` | `/auth/login` | Авторизация (JWT) |
| `POST` | `/auth/register` | Регистрация |
| `GET` | `/tle/status` | Статус TLE-данных |
| `POST` | `/tle/update` | Ручное обновление TLE |

---

## Группы спутников

| Группа | Кол-во | Источник (Celestrak) |
|--------|--------|----------------------|
| Станции (МКС, Tiangong) | ~30 | `stations` |
| Военные | ~22 | `military` |
| Метеорологические | ~70 | `weather` |
| ДЗЗ (Landsat, Sentinel) | ~160 | `resource` |
| Starlink | ~9 900 | `starlink` |
| OneWeb | ~650 | `oneweb` |

Данные автоматически обновляются с [Celestrak](https://celestrak.org) при каждом запуске.

---

## Структура проекта

```
sputnik/
├── backend/
│   ├── main.py              # Точка входа FastAPI
│   ├── config.py            # Настройки (pydantic-settings)
│   ├── database.py          # SQLAlchemy engine
│   ├── models/              # ORM-модели (7 таблиц)
│   │   ├── satellite.py     # Спутник (NORAD ID, TLE, группа)
│   │   ├── user.py          # Пользователь
│   │   ├── role.py          # Роли (user, leader, admin)
│   │   ├── favorite.py      # Избранное
│   │   ├── chat_message.py  # Сообщения чата
│   │   └── pass_history.py  # История пролётов
│   ├── routers/             # API-эндпоинты (6 роутеров)
│   │   ├── satellites.py    # CRUD спутников
│   │   ├── passes.py        # Прогноз пролётов
│   │   ├── auth.py          # Авторизация
│   │   ├── tle.py           # Управление TLE
│   │   ├── favorites.py     # Избранное
│   │   └── chat.py          # Чат
│   ├── services/            # Бизнес-логика (6 сервисов)
│   │   ├── sgp4_service.py  # Орбитальные расчёты
│   │   ├── tle_updater.py   # Загрузка TLE с Celestrak
│   │   ├── tle_parser.py    # Парсинг TLE
│   │   ├── pass_service.py  # Расчёт пролётов
│   │   ├── auth_service.py  # JWT + пароли
│   │   └── email_service.py # Токены email
│   └── requirements.txt     # Зависимости Python
├── frontend/
│   ├── earth_visualizer.html # Главная страница
│   ├── js/app.js            # Основная логика (~5000 строк)
│   ├── css/style.css        # Стили
│   └── lib/                 # Локальные библиотеки
├── DATA/
│   └── tle/                 # Кэш TLE-файлов
├── docs/                    # Презентация и речь
└── deploy.sh                # Скрипт деплоя
```

---

## Лицензия

Проект разработан в рамках хакатона РНИИРС.
