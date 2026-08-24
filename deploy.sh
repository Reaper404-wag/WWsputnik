#!/bin/bash
# ============================================================
#  SPUTNIK — Полный деплой на Ubuntu (nginx + systemd + SSL)
#  Домен: wwsputnik.ru
#  Использование: bash deploy.sh
# ============================================================
set -e

DOMAIN="wwsputnik.ru"
PROJECT_DIR="/opt/sputnik"
BACKEND_PORT=8003
USER="sputnik"

echo "=========================================="
echo "  SPUTNIK — Deploy Script"
echo "  Домен: $DOMAIN"
echo "=========================================="

# ── 1. Системные пакеты ──
echo "[1/8] Установка системных пакетов..."
apt update -y
apt install -y python3 python3-venv python3-pip nginx certbot python3-certbot-nginx git curl ufw

# ── 2. Создать пользователя ──
echo "[2/8] Создание пользователя $USER..."
id -u $USER &>/dev/null || useradd -r -m -s /bin/bash $USER

# ── 3. Копирование проекта ──
echo "[3/8] Подготовка проекта в $PROJECT_DIR..."
mkdir -p $PROJECT_DIR
# Копируем всё из текущей директории (скрипт запускается из корня проекта)
cp -r backend frontend DATA parcer.py "$PROJECT_DIR/" 2>/dev/null || true
mkdir -p "$PROJECT_DIR/DATA/tle"
chown -R $USER:$USER $PROJECT_DIR

# ── 4. Python venv + зависимости ──
echo "[4/8] Установка Python-зависимостей..."
cd $PROJECT_DIR
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r backend/requirements.txt
deactivate

# ── 5. .env файл ──
echo "[5/8] Создание .env..."
if [ ! -f "$PROJECT_DIR/.env" ]; then
    SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))")
    cat > "$PROJECT_DIR/.env" << ENVEOF
APP_TITLE=Sputnik — Мониторинг спутников
APP_VERSION=1.0.0
DEBUG=false
DATABASE_URL=sqlite:///$PROJECT_DIR/sputnik.db
SECRET_KEY=$SECRET
CORS_ORIGINS=https://$DOMAIN,http://$DOMAIN,http://localhost:5500
TLE_UPDATE_INTERVAL_SECONDS=86400
TLE_DATA_DIR=$PROJECT_DIR/DATA/tle
TLE_GROUPS=stations,military,weather,resource,starlink,oneweb
ENVEOF
    chown $USER:$USER "$PROJECT_DIR/.env"
    echo "  -> .env создан с новым SECRET_KEY"
else
    echo "  -> .env уже существует, пропускаю"
fi

# ── 6. Systemd-сервис для бэкенда ──
echo "[6/8] Настройка systemd-сервиса..."
cat > /etc/systemd/system/sputnik.service << SVCEOF
[Unit]
Description=Sputnik Backend (FastAPI/Uvicorn)
After=network.target

[Service]
Type=simple
User=$USER
Group=$USER
WorkingDirectory=$PROJECT_DIR
Environment=PATH=$PROJECT_DIR/venv/bin:/usr/local/bin:/usr/bin
EnvironmentFile=$PROJECT_DIR/.env
ExecStart=$PROJECT_DIR/venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port $BACKEND_PORT --workers 2
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable sputnik
systemctl restart sputnik
echo "  -> Бэкенд запущен на порту $BACKEND_PORT"

# ── 7. Nginx конфигурация ──
echo "[7/8] Настройка nginx..."

# Заменяем API_BASE в app.js на продакшн
sed -i "s|const API_BASE = .*|const API_BASE = 'https://$DOMAIN/api';|" "$PROJECT_DIR/frontend/js/app.js" 2>/dev/null || \
sed -i "s|const API_BASE = .*|const API_BASE = 'http://$DOMAIN/api';|" "$PROJECT_DIR/frontend/js/app.js"

cat > /etc/nginx/sites-available/sputnik << NGXEOF
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;

    # Фронтенд (статика)
    root $PROJECT_DIR/frontend;
    index earth_visualizer.html;

    # Главная страница
    location / {
        try_files \$uri \$uri/ /earth_visualizer.html;
    }

    # API — проксируем на FastAPI
    location /api/ {
        proxy_pass http://127.0.0.1:$BACKEND_PORT/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
    }

    # Кэширование статики
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 1000;
}
NGXEOF

# Включить сайт
ln -sf /etc/nginx/sites-available/sputnik /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl restart nginx
echo "  -> Nginx настроен"

# ── 8. Firewall ──
echo "[8/8] Настройка firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo ""
echo "=========================================="
echo "  ДЕПЛОЙ ЗАВЕРШЁН!"
echo "=========================================="
echo ""
echo "  Сайт: http://$DOMAIN"
echo "  API:  http://$DOMAIN/api/docs"
echo ""
echo "  Для SSL (после привязки DNS):"
echo "    certbot --nginx -d $DOMAIN -d www.$DOMAIN"
echo ""
echo "  Управление:"
echo "    systemctl status sputnik   — статус бэкенда"
echo "    systemctl restart sputnik  — перезапуск"
echo "    journalctl -u sputnik -f   — логи"
echo ""
echo "  ВАЖНО: привяжите A-запись домена к IP сервера!"
echo "=========================================="
