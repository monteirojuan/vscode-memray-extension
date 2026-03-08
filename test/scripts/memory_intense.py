def allocate():
    a = []
    for i in range(200000):
        a.append(i)
    return len(a)

if __name__ == '__main__':
    print(allocate())
