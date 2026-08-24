from sqlalchemy import create_engine, Column, Integer, String, Float
from sqlalchemy.orm import declarative_base, sessionmaker


engine = create_engine('sqlite:///example.db', echo=False)
Base = declarative_base()
Session = sessionmaker(bind=engine)



class Sputnik(Base):
    __tablename__ = 'sputnik'
    id = Column(Integer, primary_key=True)
    name = Column(String)
    norad = Column(String)
    year_start = Column(Integer)
    count_start = Column(Integer)
    get_tle = Column(String)
    first_date = Column(String)
    second_date = Column(String)
    braking_coef = Column(Float)
    type_efemerid = Column(String)
    number_element = Column(String)
    last_sum = Column(String)
    orbital_inclination = Column(Float)
    node_longitude = Column(Float)
    orbital_eccentricity = Column(Float)
    perigee_argument = Column(Float)
    average_anomaly = Column(Float)
    average_revolutions = Column(Float)
    number_vitka = Column(String)
    control_sum = Column(String)

Base.metadata.create_all(engine)

def add_sputnik(name, norad, year_start, count_start, get_tle, first_date, second_date, braking_coef, type_efemerid, number_element,
            last_sum, orbital_inclination, node_longitude, orbital_eccentricity, perigee_argument, average_anomaly, average_revolutions, number_vitka, control_sum):
    with Session() as session:
         mks = Sputnik(name=name, norad=norad, year_start=year_start, count_start=count_start, get_tle=get_tle, first_date=first_date, second_date=second_date,
                       braking_coef=braking_coef, type_efemerid=type_efemerid, number_element=number_element, last_sum=last_sum, orbital_inclination=orbital_inclination, node_longitude=node_longitude,
                       orbital_eccentricity=orbital_eccentricity, perigee_argument=perigee_argument, average_anomaly=average_anomaly, average_revolutions=average_revolutions, number_vitka=number_vitka, control_sum=control_sum)
         session.add(mks)
         session.commit()
