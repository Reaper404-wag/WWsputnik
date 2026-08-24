import math
from typing import Union

import requests
from main import add_sputnik
from main import add_sputnik


def fetch_tle_data(group: str = "last-30-days"):
    url = "https://celestrak.org/NORAD/elements/gp.php"
    params = {
        "GROUP": group,
        "FORMAT": "tle"
    }

    try:
        response = requests.get(url, params=params, timeout=30)
        response.raise_for_status()  # Проверка на ошибки HTTP
        # Устанавливаем кодировку, так как данные могут содержать символы
        response.encoding = 'utf-8'
        tle_list = []
        for line in range(0, len(response.text.splitlines()),3):
            chunk = response.text.splitlines()[line:line + 3]
            decode_tle(chunk)
        return print('nice!')
    except requests.exceptions.RequestException as e:
        print(f"Ошибка загрузки: {e}")
        return ""



def decode_tle(tle_list):
    try:
        line1 = tle_list[0]
        line2 = tle_list[1]
        line3 = tle_list[2]
        mylist = list(line2.split(" ") + line3.split(" "))
        mylist = [item for item in mylist if item != '']
        # for el in mylist:
        #     if el == '':
        #         mylist.remove(el)
        print(mylist)
        name = line1
        norad = mylist[1] #Идентификатор NORAD
        year_start = mylist[2][:-4] #Год запуска
        count_start = mylist[2][2:-1] #Номер запуска в году
        a = float('0'+mylist[3][5:])
        get_tle = mylist[3][2:-10]+'.'+mylist[3][4:-9]+'.'+mylist[3][:2]+' '+ str(int(a*86400 // 3600))+':'+str(int(a*86400 % 3600)//60)+':'+str(int(a*86400 % 60))
        #Эпоха, дату и время получения указанных TLE-строк
        first_date = mylist[4] #Первая производная от среднего движения (ускорение) деленная попалам в размерности виток/день**2
        second_date = mylist[5] #Вторая производная от среднего движения в размерности виток/день**3
        braking_coef_temp = int(mylist[6][:-2]) # Кооэфициент торможения !
        decimal_places = len(str(abs(braking_coef_temp)))
        result = braking_coef_temp / (10 ** decimal_places)
        braking_coef = result*math.e + int(mylist[6][-2:])
        type_efemerid = mylist[7] #Тип эфемерид, сейчас всегда равен 0
        number_element = mylist[8][:-1] #Номер набора элементов
        last_sum = mylist[8][-1:]
        orbital_inclination = float(mylist[11]) # Наклонение орбиты в градусах !
        node_longitude = float(mylist[12]) #Долгота восходящего узла в градусах !
        orbital_eccentricity = float(mylist[13]) #Эксцентриситет орбиты !
        perigee_argument = float(mylist[14]) #Аргумент перигея в градусах !
        average_anomaly = float(mylist[15])  # Средняя аномалия в градусах !
        average_revolutions = float(mylist[16]) #Среднее число оборотов в сутки !
        number_vitka = mylist[17][:-1] #Номер витка за эпоху
        control_sum = mylist[17][-1:] # Контрольная сумма

        return add_sputnik(name, norad, year_start, count_start, get_tle, first_date, second_date, braking_coef,
                           type_efemerid, number_element,
                           last_sum, orbital_inclination, node_longitude, orbital_eccentricity, perigee_argument,
                           average_anomaly, average_revolutions, number_vitka, control_sum)
    except(TypeError, ValueError, IndexError):
        print('Еррор')





decode_tle(fetch_tle_data())



