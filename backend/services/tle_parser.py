"""
services/tle_parser.py — Парсинг TLE-данных.

Принимает сырые TLE-строки (формат NORAD/NASA) и возвращает
объекты EarthSatellite (skyfield) для дальнейших расчётов через sgp4_service.

Формат TLE:
  Строка 0 (опционально): Название спутника
  Строка 1: 1 NNNNN...  (69 символов)
  Строка 2: 2 NNNNN...  (69 символов)
"""

from typing import List, Tuple, Optional
from skyfield.api import EarthSatellite, load


# Глобальный объект timescale — создаётся один раз, используется везде
ts = load.timescale()


def parse_tle(name: str, line1: str, line2: str) -> EarthSatellite:
    """
    Парсит одну TLE-запись → объект EarthSatellite (skyfield).

    Args:
        name:  Название спутника (например, "ISS (ZARYA)")
        line1: Первая строка TLE (начинается с "1 ")
        line2: Вторая строка TLE (начинается с "2 ")

    Returns:
        EarthSatellite — объект skyfield для расчёта позиции через SGP4.

    Raises:
        ValueError: если строки не соответствуют формату TLE.
    """
    # Валидация базового формата
    line1 = line1.strip()
    line2 = line2.strip()

    if not line1.startswith("1 "):
        raise ValueError(f"TLE line1 должна начинаться с '1 ': {line1[:20]}...")
    if not line2.startswith("2 "):
        raise ValueError(f"TLE line2 должна начинаться с '2 ': {line2[:20]}...")

    satellite = EarthSatellite(line1, line2, name.strip(), ts)
    return satellite


def parse_tle_file(text: str) -> List[Tuple[str, EarthSatellite]]:
    """
    Парсит целый TLE-файл (формат Celestrak: name + line1 + line2, повторяющиеся блоки).

    Args:
        text: Содержимое файла с TLE-данными (несколько спутников подряд).

    Returns:
        Список кортежей (name, EarthSatellite).
        Спутники с ошибками пропускаются (логируются, но не ломают парсинг).
    """
    lines = [line.rstrip() for line in text.strip().splitlines() if line.strip()]
    satellites: List[Tuple[str, EarthSatellite]] = []
    errors: List[str] = []

    i = 0
    while i < len(lines):
        # Ищем блок: name (строка без "1 " / "2 "), затем line1, line2
        if i + 2 < len(lines) and lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 "):
            # Стандартный формат: name + line1 + line2
            name = lines[i]
            line1 = lines[i + 1]
            line2 = lines[i + 2]
            i += 3
        elif lines[i].startswith("1 ") and i + 1 < len(lines) and lines[i + 1].startswith("2 "):
            # Формат без названия (только line1 + line2)
            line1 = lines[i]
            line2 = lines[i + 1]
            # Извлекаем NORAD ID из line1 как название
            name = f"NORAD-{line1[2:7].strip()}"
            i += 2
        else:
            # Неизвестная строка — пропускаем
            i += 1
            continue

        try:
            sat = parse_tle(name, line1, line2)
            satellites.append((name, sat))
        except (ValueError, Exception) as e:
            errors.append(f"Ошибка парсинга '{name}': {e}")
            continue

    if errors:
        # В будущем заменим на logging
        print(f"[TLE Parser] Пропущено {len(errors)} спутников:")
        for err in errors[:5]:  # Показываем первые 5 ошибок
            print(f"  - {err}")

    return satellites


def extract_norad_id(line1: str) -> int:
    """
    Извлекает NORAD Catalog Number из первой строки TLE.

    Позиции 2-6 в line1 (5 символов, с ведущими пробелами).
    Пример: '1 25544U ...' → 25544

    Args:
        line1: Первая строка TLE.

    Returns:
        NORAD ID (целое число).
    """
    return int(line1[2:7].strip())


def extract_intl_designator(line1: str) -> str:
    """
    Извлекает международное обозначение (International Designator) из line1.

    Позиции 9-16: год запуска (2 цифры) + номер запуска + часть.
    Пример: '1 25544U 98067A  ...' → '98067A'

    Args:
        line1: Первая строка TLE.

    Returns:
        Строка международного обозначения.
    """
    return line1[9:17].strip()
